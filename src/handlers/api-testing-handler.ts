import * as fs from "fs";
import * as path from "path";
import { S3, CloudWatch, AWSError } from "aws-sdk";
import { GetObjectOutput } from "aws-sdk/clients/s3";
import { PromiseResult } from "aws-sdk/lib/request";
import * as log from "lambda-log";
import { NewmanRunSummary } from "newman";
import * as newman from "newman";
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import NodeCache from "node-cache";

const s3 = new S3({ region: process.env.REGION });

const tmpDir = "/tmp";
const junitReportFilename = `${tmpDir}/newman/smoketest-junit-report.xml`;
const htmlExtraReportFilename = `${tmpDir}/newman/smoketest-htmlextra-report.html`;

export const handler = async function run() {
  log.info("Started api testing handler");
  await downloadAssets();
  const runSummary = await runTests().catch(async (reason) => {
    await updateMetric(false);
    throw reason;
  });

  const success = runSummary.run.failures.length == 0 && !runSummary.error;
  if (!success) {
    await uploadReports();
  }

  await updateMetric(success);

  const response = createResponse(success);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  log.info("Finished api testing handler.");
  return response;
};

function createResponse(success: boolean) {
  const junitReportString = fs
    .readFileSync(junitReportFilename)
    .toString("utf-8");
  return {
    success: success,
    junitReport: junitReportString,
  };
}

async function getAsset(fileName: string) {
  if (fileName === undefined) {
    return;
  }
  const s3Path = process.env.S3_DESTINATION_PREFIX + fileName;
  log.debug(`Retrieving object: ${process.env.S3_BUCKET_NAME}/${s3Path}`);
  await s3
    .getObject({
      Bucket: process.env.S3_BUCKET_NAME!,
      Key: s3Path,
    })
    .promise()
    .then((result: PromiseResult<GetObjectOutput, AWSError>) => {
      let filePath = path.join(tmpDir, fileName);
      fs.writeFileSync(filePath, result.Body!.toString("utf-8"), {
        encoding: "utf-8",
        flag: "w",
      });
      log.debug(`File created: ${filePath}`);
    });
}

async function downloadAssets() {
  log.debug("Downloading postman assets");
  for (const fileName of [
    process.env.COLLECTION_FILENAME!,
    process.env.ENVIRONMENT_FILENAME!,
    process.env.GLOBALS_FILENAME!,
  ]) {
    await getAsset(fileName);
  }
  log.debug("Postman assets downloaded");
}

async function runTests(): Promise<NewmanRunSummary> {
  const envVars = await getEnvVars();

  return new Promise(function (onResolve, onReject) {
    newman
      .run({
        collection: require(`${tmpDir}/${process.env.COLLECTION_FILENAME}`),
        environment: require(`${tmpDir}/${process.env.ENVIRONMENT_FILENAME}`),
        globals: require(`${tmpDir}/${process.env.GLOBALS_FILENAME}`),
        envVar: envVars,
        reporters: ["junit", "htmlextra"],
        timeout: 900000,
        timeoutScript: 900000,
        timeoutRequest: 10000,
        reporter: {
          junit: { export: junitReportFilename },
          htmlextra: { export: htmlExtraReportFilename },
        },
      })
      .on("start", function () {
        log.info("Starting API test execution");
      })
      .on("done", function (err: Error, summary: NewmanRunSummary) {
        if (err) {
          onReject(err);
        }

        log.info("API tests execution finished");

        if (summary.run.failures.length > 0) {
          log.warn(
            "Tests failed. Please check the reports."
          );
        }

        onResolve(summary);
      });
  });
}

async function getEnvVars(): Promise<{ value: any; key: string }[]> {
  const envVar: { value: any; key: string }[] = [];
  if (process.env.SECRET_ID) {
    log.debug(`Loading secrets with SecretId ${process.env.SECRET_ID}`);
    const secret = await retrieveSecret(process.env.SECRET_ID);
    if (secret) {
      const flattenedSecrets = require("flat")(JSON.parse(secret));
      const secretsMap = new Map<string, string>(
        Object.entries(flattenedSecrets)
      );
      const secretKeys = JSON.parse(process.env.SECRET_KEYS!);
      secretKeys.keys.forEach((key: string) => {
        log.debug(`Loading secret ${key}`);
        const secretValue = secretsMap.get(key);
        envVar.push({ key: key, value: secretValue });
      });
    } else {
      log.warn("No secrets found.");
    }
  }

  envVar.push({
    key: "accessKey",
    value: process.env.AWS_ACCESS_KEY_ID,
  });
  envVar.push({
    key: "secretKey",
    value: process.env.AWS_SECRET_ACCESS_KEY,
  });
  envVar.push({
    key: "sessionToken",
    value: process.env.AWS_SESSION_TOKEN,
  });

  return envVar;
}

async function uploadReports(): Promise<string> {
  log.info("Uploading reports.");

  const keyPath =
    process.env.REPORTS_PREFIX! +
    process.env.S3_DESTINATION_PREFIX +
    new Date().toISOString() +
    "/";
  const tmpReportsPath = `${tmpDir}/newman/`;

  const files = fs.readdirSync(tmpReportsPath);
  for (const file of files) {
    await uploadReport(tmpReportsPath + file, keyPath + file);
  }
  log.info(`Reports available at ${keyPath}`);
  return keyPath;
}

async function uploadReport(file: string, key: string) {
  log.debug(`Uploading: ${file}`);
  await s3
    .putObject({
      Bucket: process.env.S3_BUCKET_NAME!,
      Key: key,
      Body: fs.readFileSync(file),
    })
    .promise()
    .then(() => log.debug("Report uploaded."));
}

async function updateMetric(success: boolean) {
  const value = success ? 0 : 1;
  const metricName = process.env.METRIC_NAME;
  const metricNamespace = process.env.METRIC_NAMESPACE;
  if (!metricName || !metricNamespace) {
    return;
  }
  const cloudWatch = new CloudWatch();
  log.info(`Updating ${metricName} metric.`);
  await cloudWatch
    .putMetricData({
      MetricData: [
        {
          MetricName: metricName,
          Unit: "Count",
          Timestamp: new Date(),
          Value: value,
        },
      ],
      Namespace: metricNamespace,
    })
    .promise()
    .then(() => log.info("Metric updated."));
}

const client = new SecretsManagerClient({ region: process.env.AWS_REGION });
const cache = new NodeCache({
  stdTTL: 1000,
  maxKeys: 500,
  deleteOnExpire: true,
  useClones: false,
  checkperiod: 30,
});

export async function retrieveSecret(
  secretId: string
): Promise<string | undefined> {
  let secretValue: string | undefined = cache.get(secretId);
  if (secretValue === undefined) {
    secretValue = (
      await client.send(
        new GetSecretValueCommand({
          SecretId: secretId,
        })
      )
    ).SecretString;
    try {
      cache.set(secretId, secretValue);
    } catch (error) {
      log.error("Failed secret cache usage due to " + JSON.stringify(error));
    }
  }
  return secretValue;
}