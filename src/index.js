"use strict";

const { Readable } = require("stream");
const {
  CloudWatchLogsClient,
  PutLogEventsCommand,
  DescribeLogStreamsCommand,
  CreateLogStreamCommand,
} = require("@aws-sdk/client-cloudwatch-logs");
const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");
const { gunzip } = require("zlib");
const { promisify } = require("util");
const gunzipAsync = promisify(gunzip);
const readline = require("readline");
const { fields, fieldFunctions } = require("./logFields");

const MAX_BATCH_SIZE = 1048576;
const MAX_BATCH_COUNT = 10000;
const LOG_EVENT_OVERHEAD = 26;

const cloudWatchLogs = new CloudWatchLogsClient();
const s3 = new S3Client();

const loadBalancerTypeEnvKey = "LOAD_BALANCER_TYPE";
const logGroupNameEnvKey = "LOG_GROUP_NAME";
const plaintextLogsEnvKey = "PLAINTEXT_LOGS";

function getEnvVar(name) {
  return process.env[name];
}

function parseLine(logFields, line) {
  const loadBalancerType = getEnvVar(loadBalancerTypeEnvKey);
  const parsed = {};
  let x = 0;
  let end = false;
  let withinQuotes = false;
  let element = "";
  for (const c of line + " ") {
    if (end) {
      if (element) {
        const fieldName = logFields[x];
        if (element.match(/^\d+.?\d*$/)) element = Number(element);
        if (fieldFunctions[loadBalancerType]?.[fieldName])
          fieldFunctions[loadBalancerType][fieldName](element, parsed);
        parsed[fieldName] = element;
        element = "";
        x++;
      }
      end = false;
    }
    if (c.match(/^\s$/) && !withinQuotes) end = true;
    if (c === '"') withinQuotes = !withinQuotes;
    else if (!end) element += c;
  }
  return parsed;
}

async function sendBatch(logGroupName, logStreamName, logEvents, seqToken) {
  try {
    console.log(`Sending batch to ${logStreamName}`);
    const putLogEventParams = {
      logEvents,
      logGroupName,
      logStreamName,
      sequenceToken: seqToken,
    };
    putLogEventParams.logEvents.sort((a, b) => a.timestamp - b.timestamp);
    console.log("Calling PutLogEvents");
    const cwPutLogEvents = await cloudWatchLogs.send(
      new PutLogEventsCommand(putLogEventParams)
    );
    console.log(
      `Success in putting ${putLogEventParams.logEvents.length} events`
    );
    return cwPutLogEvents.nextSequenceToken;
  } catch (err) {
    console.log("Error during put log events: ", err, err.stack);
    return seqToken;
  }
}

async function getS3Object(Bucket, Key) {
  console.log(`Retrieving ${Bucket}${Key}`);
  const getObjectCommand = new GetObjectCommand({ Bucket, Key });
  const response = await s3.send(getObjectCommand);
  return response.Body;
}

async function unpackLogData(s3object) {
  console.log("Unzipping log file");
  const uncompressedLogBuffer = await gunzipAsync(s3object);
  return uncompressedLogBuffer.toString("ascii");
}

async function getLogStreamSequenceToken(logGroupName, logStreamName) {
  console.log(`Checking Log Streams ${logGroupName}/${logStreamName}`);
  let currentStream;
  const describeLogStreamsCommand = new DescribeLogStreamsCommand({
    logGroupName,
    logStreamNamePrefix: logStreamName,
  });
  const cwlDescribeStreams = await cloudWatchLogs.send(
    describeLogStreamsCommand
  );
  if (cwlDescribeStreams.logStreams[0])
    currentStream = cwlDescribeStreams.logStreams[0];
  else {
    console.log(`Creating Log Stream ${logGroupName}/${logStreamName}`);
    const createLogStreamCommand = new CreateLogStreamCommand({
      logGroupName,
      logStreamName,
    });
    await cloudWatchLogs.send(createLogStreamCommand);
    const cwlDescribeCreatedStream = await cloudWatchLogs.send(
      describeLogStreamsCommand
    );
    currentStream = cwlDescribeCreatedStream.logStreams[0];
  }
  return currentStream.uploadSequenceToken;
}

function readLogLine(logType, batcher, line) {
  const loadBalancerType = getEnvVar(loadBalancerTypeEnvKey);
  let fieldNames = fields[loadBalancerType][logType];
  if (!fieldNames) return console.log(`Unknown log type: ${logType}`);
  let timeIndex;
  for (let timeFieldName of ["time", "timestamp"]) {
    if (fieldNames.includes(timeFieldName)) {
      timeIndex = fieldNames.indexOf(timeFieldName);
      break;
    }
  }
  if (typeof timeIndex !== "number")
    return console.log(`No time field found in log type: ${logType}`);
  try {
    const parsed = parseLine(fieldNames, line);
    const ts = line.split(" ", timeIndex + 1)[timeIndex];
    const tval = Date.parse(ts);
    const event_size = line.length + LOG_EVENT_OVERHEAD;
    const plaintextLogs = getEnvVar(plaintextLogsEnvKey);
    if (!plaintextLogs) line = JSON.stringify(parsed);
    batcher.batch_size += event_size;
    if (
      batcher.batch_size >= MAX_BATCH_SIZE ||
      batcher.batch.length >= MAX_BATCH_COUNT
    ) {
      batcher.batches.push(batcher.batch);
      batcher.batch = [];
      batcher.batch_size = event_size;
    }
    batcher.batch.push({ message: line, timestamp: tval });
  } catch (err) {
    console.log("Error parsing line: ", err, err.stack);
  }
}

async function readLogClose(
  batcher,
  logGroupName,
  logStreamName,
  sequenceToken
) {
  batcher.batches.push(batcher.batch);
  console.log(
    `Finished batching, pushing ${batcher.batches.length} batches to CloudWatch`
  );
  let seqToken = sequenceToken;
  let count = 0;
  let batch_count = 0;
  for (let i = 0; i < batcher.batches.length; i++) {
    const logEvents = batcher.batches[i];
    try {
      seqToken = await sendBatch(
        logGroupName,
        logStreamName,
        logEvents,
        seqToken
      );
      ++batch_count;
      count += logEvents.length;
    } catch (err) {
      console.log("Error sending batch: ", err, err.stack);
      continue;
    }
  }
  console.log(`Successfully put ${count} events in ${batch_count} batches`);
}

exports.handler = async (event) => {
  const logGroupName = getEnvVar(logGroupNameEnvKey);
  const loadBalancerType = getEnvVar(loadBalancerTypeEnvKey);
  try {
    console.log(JSON.stringify(event));
    const records = event?.Records;
    if (!records) throw new Error("No records found in event");

    for (let record of records) {
      if (record?.eventSource === "aws:sqs") record = JSON.parse(record.body);
      if (record?.eventSource !== "aws:s3") {
        console.warn("Ignoring non-S3 event source");
        continue;
      }
      const bucket = record?.s3?.bucket?.name;
      if (!bucket) throw new Error("No bucket found in record");

      const key = decodeURIComponent(
        record?.s3?.object?.key?.replace(/\+/g, " ")
      );
      if (!key) throw new Error("No key found in record");

      const logStreamName = key;
      const s3object = await getS3Object(bucket, key);
      const logData = await unpackLogData(s3object);

      let logType;
      switch (true) {
        case key.includes("conn_log"):
          logType = "connection";
          break;
        default:
          logType = "access";
      }

      console.log(`${loadBalancerType} load balancer: ${logType} log`);

      let sequenceToken = await getLogStreamSequenceToken(
        logGroupName,
        logStreamName
      );

      console.log("Parsing log lines");
      var batcher = {
        batches: [],
        batch: [],
        batch_size: 0,
      };
      var bufferStream = new Readable();
      bufferStream.push(logData);
      bufferStream.push(null);

      await new Promise((resolve, reject) => {
        try {
          let rl = readline.createInterface({ input: bufferStream });
          rl.on("line", (line) => readLogLine(logType, batcher, line));
          rl.on("close", async () => {
            console.log("Finished reading log lines");
            await readLogClose(
              batcher,
              logGroupName,
              logStreamName,
              sequenceToken
            );
            resolve();
          });
        } catch (err) {
          reject(err);
        }
      });
    }
  } catch (err) {
    console.log("Error: ", err, err.stack);
    return;
  } finally {
    console.log("Finished");
  }
};
