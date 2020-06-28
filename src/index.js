'use strict';

const readline = require('readline');
const stream = require('stream');

const zlib = require('zlib');
const {
    promisify,
} = require('util');
const gunzipAsync = promisify(zlib.gunzip);

const aws = require('aws-sdk');
const s3 = new aws.S3({
    apiVersion: '2006-03-01'
});
const cloudWatchLogs = new aws.CloudWatchLogs({
    apiVersion: '2014-03-28'
});

//specifying the log group and the log stream name for CloudWatch Logs
const logGroupName = process.env.LOG_GROUP_NAME;
const classicElbMode = process.env.CLASSIC_ELB_MODE;

exports.handler = async (event, context) => {
    const logStreamName = context.logStreamName;
    const bucket = event.Records[0].s3.bucket.name;
    const key = decodeURIComponent(event.Records[0].s3.object.key.replace(/\+/g, ' '));
    console.log(bucket);
    console.log(key);

    const object = await s3.getObject({
        Bucket: bucket,
        Key: key,
    }).promise();

    let logData;
    if (classicElbMode) logData = object.Body.toString('ascii')
    else {
        const uncompressedLogBuffer = await gunzipAsync(object.Body);
        logData = uncompressedLogBuffer.toString('ascii');
    }

    // y tho
    // const cwlDescribeGroups = await cloudWatchLogs.describeLogGroups({
    //     logGroupNamePrefix: logGroupName
    // }).promise();

    // if (!cwlDescribeGroups.logGroups[0]) {
    //     const cwlCreateGroup = await cloudWatchLogs.createLogGroup({
    //         logGroupName
    //     }).promise();
    // }

    const cwlDescribeStreams = await cloudWatchLogs.describeLogStreams({
        logGroupName: logGroupName,
        logStreamNamePrefix: logStreamName
    }).promise();

    if (!cwlDescribeStreams.logStreams[0]) {
        await cloudWatchLogs.createLogStream({
            logGroupName,
            logStreamName,
        }).promise();
    }

    putLogEvents(cwlDescribeStreams.logStreams[0].uploadSequenceToken, logData);

    function putLogEvents(sequenceToken, logData) {
        //From http://docs.aws.amazon.com/AmazonCloudWatchLogs/latest/APIReference/API_PutLogEvents.html
        const MAX_BATCH_SIZE = 1048576; // maximum size in bytes of Log Events (with overhead) per invocation of PutLogEvents
        const MAX_BATCH_COUNT = 10000; // maximum number of Log Events per invocation of PutLogEvents
        const LOG_EVENT_OVERHEAD = 26; // bytes of overhead per Log Event

        // holds a list of batches
        var batches = [];

        // holds the list of events in current batch
        var batch = [];

        // size of events in the current batch
        var batch_size = 0;

        var bufferStream = new stream.PassThrough();
        bufferStream.end(logData);

        var rl = readline.createInterface({
            input: bufferStream
        });

        var line_count = 0;

        rl.on('line', (line) => {
            ++line_count;

            var ts = line.split(' ', 2)[1];
            var tval = Date.parse(ts);

            var event_size = line.length + LOG_EVENT_OVERHEAD;

            batch_size += event_size;

            if (batch_size >= MAX_BATCH_SIZE ||
                batch.length >= MAX_BATCH_COUNT) {
                // start a new batch
                batches.push(batch);
                batch = [];
                batch_size = event_size;
            }

            batch.push({
                message: line,
                timestamp: tval
            });
        });

        rl.on('close', () => {
            // add the final batch
            batches.push(batch);
            sendBatches(sequenceToken, batches);
        });
    }

    function sendBatches(sequenceToken, batches) {
        var count = 0;
        var batch_count = 0;

        function sendNextBatch(err, nextSequenceToken) {
            if (err) {
                console.log('Error sending batch: ', err, err.stack);
                return;
            } else {
                var nextBatch = batches.shift();
                if (nextBatch) {
                    // send this batch
                    ++batch_count;
                    count += nextBatch.length;
                    sendBatch(nextSequenceToken, nextBatch, sendNextBatch);
                } else {
                    // no more batches: we are done
                    var msg = `Successfully put ${count} events in ${batch_count} batches`;
                    console.log(msg);
                    callback(null, msg);
                }
            }
        }

        sendNextBatch(null, sequenceToken);
    }

    function sendBatch(sequenceToken, batch, doNext) {
        var putLogEventParams = {
            logEvents: batch,
            logGroupName: logGroupName,
            logStreamName: logStreamName
        }
        if (sequenceToken) {
            putLogEventParams['sequenceToken'] = sequenceToken;
        }

        // sort the events in ascending order by timestamp as required by PutLogEvents
        putLogEventParams.logEvents.sort(function (a, b) {
            if (a.timestamp > b.timestamp) {
                return 1;
            }
            if (a.timestamp < b.timestamp) {
                return -1;
            }
            return 0;
        });

        cloudWatchLogs.putLogEvents(putLogEventParams, function (err, data) {
            if (err) {
                console.log('Error during put log events: ', err, err.stack);
                doNext(err, null);
            } else {
                console.log(`Success in putting ${putLogEventParams.logEvents.length} events`);
                doNext(null, data.nextSequenceToken);
            }
        });
    }
};