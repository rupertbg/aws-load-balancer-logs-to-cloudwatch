const { mockClient } = require("aws-sdk-client-mock");
const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");
const {
  CloudWatchLogsClient,
  PutLogEventsCommand,
  DescribeLogStreamsCommand,
} = require("@aws-sdk/client-cloudwatch-logs");
const { createReadStream } = require("fs");
const zlib = require("zlib");
const { sdkStreamMixin } = require("@smithy/util-stream");

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

  // Read the file from disk and gzip compress the file
  const gzippedLogFileContents = createReadStream(
    `${__dirname}/logs/${logFile}`
  ).pipe(zlib.createGzip());

  // AWS SDK Steam type
  const sdkStream = sdkStreamMixin(gzippedLogFileContents);

  // Mock the S3 getObject command to return the contents of the fake log file
  s3Mock
    .on(GetObjectCommand, {
      Bucket: mockBucketName,
      Key: logFile,
    })
    .resolves({
      Body: sdkStream,
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
  return {
    result: await handler(inputEvent),
    logEventParamObjs,
  };
}

for (let loadBalancerType in logFileTests) {
  for (let logType in logFileTests[loadBalancerType]) {
    describe(`${loadBalancerType} load balancer ${logType} log delivery`, () => {
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

      it(`should deliver ${loadBalancerType} load balancer ${logType} logs correctly when called via s3`, async () => {
        const { result, logEventParamObjs } = await runTest(
          {
            LOG_GROUP_NAME: loadBalancerType,
            LOAD_BALANCER_TYPE: loadBalancerType,
          },
          logType,
          {
            Records: [s3Event],
          }
        );
        expect(logEventParamObjs).toEqual(
          logFileTests[loadBalancerType][logType].result
        );
        expect(result).toEqual(undefined);
      });

      it(`should deliver ${loadBalancerType} load balancer ${logType} logs correctly when called via sqs`, async () => {
        const { result, logEventParamObjs } = await runTest(
          {
            LOG_GROUP_NAME: loadBalancerType,
            LOAD_BALANCER_TYPE: loadBalancerType,
          },
          logType,
          {
            Records: [sqsEvent],
          }
        );
        expect(logEventParamObjs).toEqual(
          logFileTests[loadBalancerType][logType].result
        );
        expect(result).toEqual({
          batchItemFailures: [],
        });
      });
    });
    describe(`${loadBalancerType} load balancer ${logType} sqs failures`, () => {
      it("should return a batchItemFailure when the record is invalid", async () => {
        const invalidRecord = {
          eventSource: "aws:sqs",
          messageId: "invalid",
          body: "invalid",
        };
        const { result, logEventParamObjs } = await runTest(
          {
            LOG_GROUP_NAME: "sqs-tests",
            LOAD_BALANCER_TYPE: "application",
          },
          logType,
          {
            Records: [invalidRecord],
          }
        );
        expect(logEventParamObjs).toEqual([]);
        expect(result).toEqual({
          batchItemFailures: [
            {
              itemIdentifier: "invalid",
            },
          ],
        });
      });
      it("should continue if no records are found in the event", async () => {
        const { result, logEventParamObjs } = await runTest(
          {
            LOG_GROUP_NAME: "sqs-tests",
            LOAD_BALANCER_TYPE: "application",
          },
          logType,
          {}
        );
        expect(logEventParamObjs).toEqual([]);
        expect(result).toEqual(undefined);
      });
      it("should ignore events that are not an s3 or sqs event", async () => {
        const { result, logEventParamObjs } = await runTest(
          {
            LOG_GROUP_NAME: "sqs-tests",
            LOAD_BALANCER_TYPE: "application",
          },
          logType,
          {
            Records: [
              {
                eventSource: "aws:lambda",
              },
            ],
          }
        );
        expect(logEventParamObjs).toEqual([]);
        expect(result).toEqual(undefined);
      });
    });
  }
}
