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
const loadBalancerType = process.env.LOAD_BALANCER_TYPE;

const MAX_BATCH_SIZE = 1048576; // maximum size in bytes of Log Events (with overhead) per invocation of PutLogEvents
const MAX_BATCH_COUNT = 10000; // maximum number of Log Events per invocation of PutLogEvents
const LOG_EVENT_OVERHEAD = 26; // bytes of overhead per Log Event

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
    if (loadBalancerType === "classic") logData = object.Body.toString('ascii')
    else {
        const uncompressedLogBuffer = await gunzipAsync(object.Body);
        logData = uncompressedLogBuffer.toString('ascii');
    }

    let currentStream;
    const cwlDescribeStreams = await cloudWatchLogs.describeLogStreams({
        logGroupName: logGroupName,
        logStreamNamePrefix: logStreamName
    }).promise();

    if (cwlDescribeStreams.logStreams[0]) currentStream = cwlDescribeStreams.logStreams[0]
    else {
        await cloudWatchLogs.createLogStream({
            logGroupName,
            logStreamName,
        }).promise();
        const cwlDescribeCreatedStream = await cloudWatchLogs.describeLogStreams({
            logGroupName: logGroupName,
            logStreamNamePrefix: logStreamName
        }).promise();
        currentStream = cwlDescribeCreatedStream.logStreams[0]
    }

    let sequenceToken = currentStream.uploadSequenceToken

    var batches = [];
    var batch = [];
    var batch_size = 0;
    var bufferStream = new stream.PassThrough();
    bufferStream.end(logData);

    var rl = readline.createInterface({
        input: bufferStream
    });

    var line_count = 0;
    rl.on('line', (line) => {
        ++line_count;

        let ts;
        switch (loadBalancerType) {
            case 'classic':
                ts = line.split(' ', 1)[0];
                break;
            case 'application':
                ts = line.split(' ', 2)[1];
                break;
            case 'network':
                ts = line.split(' ', 3)[2];
                break;
            default:
                console.error('Invalid load balancer type');
                process.exit(1);
        }

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
            timestamp: tval,
        });
    });

    rl.on('close', sendBatches);

    function sendBatches() {
        batches.push(batch);
        for (let i = 0; i < batches.length; i++) {
            const batch = batches[i];
            var count = 0;
            var batch_count = 0;
            try {
                ++batch_count;
                count += batch.length;
                var putLogEventParams = {
                    logEvents: batch,
                    logGroupName: logGroupName,
                    logStreamName: logStreamName
                }
                if (sequenceToken) putLogEventParams['sequenceToken'] = sequenceToken;

                // sort the events in ascending order by timestamp as required by PutLogEvents
                putLogEventParams.logEvents.sort(function(a, b) {
                    if(a.timestamp > b.timestamp) return 1;
                    if(a.timestamp < b.timestamp) return -1;
                    return 0;
                });

                try {
                    const cwPutLogEvents = await cloudWatchLogs.putLogEvents (putLogEventParams).promise();
                    console.log(`Success in putting ${putLogEventParams.logEvents.length} events`);
                    sequenceToken = cwPutLogEvents.nextSequenceToken
                } catch (err) {
                    console.log('Error during put log events: ', err, err.stack);
                }
            } catch (err) {
                console.log('Error sending batch: ', err, err.stack);
                continue;
            }
        }
        console.log(`Successfully put ${count} events in ${batch_count} batches`);
    }
};