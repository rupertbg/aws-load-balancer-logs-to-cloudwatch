const { mockClient } = require("aws-sdk-client-mock");
const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");
const {
  CloudWatchLogsClient,
  PutLogEventsCommand,
  DescribeLogStreamsCommand,
} = require("@aws-sdk/client-cloudwatch-logs");
const { readFileSync } = require("fs");
const promisify = require("util").promisify;
const gzip = require("zlib").gzip;
const gzipAsync = promisify(gzip);

const s3Mock = mockClient(S3Client);
const cwLogsMock = mockClient(CloudWatchLogsClient);

const mockBucketName = "logs";
const logFileTests = require("./logFileTests.json");

const { handler } = require("../index");

async function setupTests(envVars, logType) {
  s3Mock.reset();
  cwLogsMock.reset();
  for (const envVar in envVars) {
    process.env[envVar] = envVars[envVar];
  }

  const logFile = logFileTests[envVars.LOAD_BALANCER_TYPE][logType].filename;

  // Read the file from disk
  const logFileContents = readFileSync(`${__dirname}/logs/${logFile}`);

  // Gzip compress the file
  const gzippedLogFileContents = await gzipAsync(logFileContents);

  // Mock the S3 getObject command to return the contents of the fake log file
  s3Mock
    .on(GetObjectCommand, {
      Bucket: mockBucketName,
      Key: logFile,
    })
    .resolves({
      Body: gzippedLogFileContents,
    });

  // Mock the CloudWatch DescribeLogStreams command
  cwLogsMock.on(DescribeLogStreamsCommand).resolves({
    logStreams: [
      {
        uploadSequenceToken: "token",
      },
    ],
  });

  // Mock the CloudWatch PutLogEvents command to capture the parameters
  let logEventParamObjs = [];
  cwLogsMock.on(PutLogEventsCommand).callsFake((params) => {
    logEventParamObjs.push(params);
    return {
      nextSequenceToken: "token",
    };
  });

  return logEventParamObjs;
}

async function runTest(envVars, logType, inputEvent) {
  const loadBalancerType = envVars.LOAD_BALANCER_TYPE;
  const logEventParamObjs = await setupTests(envVars, logType);
  await handler(inputEvent);
  expect(logEventParamObjs).toEqual(
    logFileTests[loadBalancerType][logType].result
  );
}

describe("log delivery", () => {
  for (let loadBalancerType in logFileTests) {
    for (let logType in logFileTests[loadBalancerType]) {
      const logFile = logFileTests[loadBalancerType][logType].filename;
      const s3Event = {
        eventSource: "aws:s3",
        eventName: "ObjectCreated:Put",
        s3: {
          bucket: { name: mockBucketName },
          object: { key: logFile },
        },
      };
      const sqsEvent = {
        eventSource: "aws:sqs",
        body: JSON.stringify({
          Records: [s3Event],
        }),
      };

      let logEventParamObjs;
      it(`should deliver ${loadBalancerType} load balancer ${logType} logs correctly when called via s3`, async () => {
        await runTest(
          {
            LOG_GROUP_NAME: loadBalancerType,
            LOAD_BALANCER_TYPE: loadBalancerType,
          },
          logType,
          {
            Records: [s3Event],
          }
        );
      });

      it(`should deliver ${loadBalancerType} load balancer ${logType} logs correctly when called via sqs`, async () => {
        await runTest(
          {
            LOG_GROUP_NAME: loadBalancerType,
            LOAD_BALANCER_TYPE: loadBalancerType,
          },
          logType,
          {
            Records: [sqsEvent],
          }
        );
      });
    }
  }
});
