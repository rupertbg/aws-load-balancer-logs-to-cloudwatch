'use strict';

const readline = require('readline');
const stream = require('stream');
const url = require('url');

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
const plaintextLogs = process.env.PLAINTEXT_LOGS;

const MAX_BATCH_SIZE = 1048576; // maximum size in bytes of Log Events (with overhead) per invocation of PutLogEvents
const MAX_BATCH_COUNT = 10000; // maximum number of Log Events per invocation of PutLogEvents
const LOG_EVENT_OVERHEAD = 26; // bytes of overhead per Log Event

const fields = {
    application: [
        "type",
        "time",
        "elb",
        "client:port",
        "target:port",
        "request_processing_time",
        "target_processing_time",
        "response_processing_time",
        "elb_status_code",
        "target_status_code",
        "received_bytes",
        "sent_bytes",
        "request",
        "user_agent",
        "ssl_cipher",
        "ssl_protocol",
        "target_group_arn",
        "trace_id",
        "domain_name",
        "chosen_cert_arn",
        "matched_rule_priority",
        "request_creation_time",
        "actions_executed",
        "redirect_url",
        "error_reason",
        "target:port_list",
        "target_status_code_list"
    ],
    classic: [
        "time",
        "elb",
        "client:port",
        "backend:port",
        "request_processing_time",
        "backend_processing_time",
        "response_processing_time",
        "elb_status_code",
        "backend_status_code",
        "received_bytes",
        "sent_bytes",
        "request",
        "user_agent",
        "ssl_cipher",
        "ssl_protocol"
    ],
    network: [
        "type",
        "version",
        "time",
        "elb",
        "listener",
        "client:port",
        "destination:port",
        "connection_time",
        "tls_handshake_time",
        "received_bytes",
        "sent_bytes",
        "incoming_tls_alert",
        "chosen_cert_arn",
        "chosen_cert_serial",
        "tls_cipher",
        "tls_protocol_version",
        "tls_named_group",
        "domain_name",
        "alpn_fe_protocol",
        "alpn_be_protocol",
        "alpn_client_preference_list"
    ]
}

exports.handler = async (event, context) => {
    const logStreamName = context.logStreamName;
    const bucket = event.Records[0].s3.bucket.name;
    const key = decodeURIComponent(event.Records[0].s3.object.key.replace(/\+/g, ' '));
    const s3object = await getS3Object(bucket, key);
    const logData = await unpackLogData(s3object);
    await createLogGroupIfNotExists();

    let sequenceToken = await getLogStreamSequenceToken(logStreamName);

    console.log('Parsing log lines');
    var batches = [];
    var batch = [];
    var batch_size = 0;
    var bufferStream = new stream.PassThrough();
    bufferStream.end(logData);

    var rl = readline.createInterface({
        input: bufferStream
    });

    function portField(fieldName, element, parsed) {
        const field = fieldName.split(':')[0];
        const [ip, port] = element.split(':');
        if (ip === '-1') parsed[field] = parseInt(ip)
        else parsed[field] = ip;

        if (port) parsed[`${field}_port`] = parseInt(port)
        else parsed[`${field}_port`] = -1
    }

    // Functions that mutate the parsed object
    const fieldFunctions = {
        "request": (fieldName, element, parsed) => {
            const [request_method, request_uri, request_http_version] = element.split(/\s+/)
            parsed.request_method = request_method
            parsed.request_uri = request_uri
            parsed.request_http_version = request_http_version
            const parsedUrl = url.parse(request_uri)
            parsed.request_uri_scheme = parsedUrl.protocol
            parsed.request_uri_host = parsedUrl.hostname
            if (parsedUrl.port) parsed.request_uri_port = parseInt(parsedUrl.port)
            parsed.request_uri_path = parsedUrl.pathname
            parsed.request_uri_query = parsedUrl.query
        },
        "target:port": portField,
        "client:port": portField,
        "backend:port": portField,
    }

    function readLines(line) {
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

        if (!plaintextLogs) line = JSON.stringify(parseLine(line));

        batch.push({
            message: line,
            timestamp: tval,
        });
    }

    function parseLine(line) {
        console.log('Parsing log line')
        const parsed = {}
        let x = 0
        let end = false
        let withinQuotes = false
        let element = ''
        for (const c of line + ' ') {
            if (end) {
                if (element) {
                    const fieldName = fields[loadBalancerType][x]

                    if (element.match(/^\d+.?\d*$/)) element = Number(element)

                    if (fieldFunctions[fieldName]) fieldFunctions[fieldName](fieldName, element, parsed)

                    parsed[fieldName] = element;

                    element = '';
                    x++;
                }
                end = false;
            };

            if (c.match(/^\s$/) && !withinQuotes) end = true;

            if (c === '"') {
                if (withinQuotes) end = true
                withinQuotes = !withinQuotes;
            }
            else if (!end) element += c;
        }
        return parsed
    }

    async function sendBatch(logEvents) {
        console.log(`Sending batch to ${logStreamName}`);
        var putLogEventParams = {
            logEvents,
            logGroupName,
            logStreamName,
            sequenceToken,
        }

        // sort the events in ascending order by timestamp as required by PutLogEvents
        putLogEventParams.logEvents.sort((a, b) => {
            if (a.timestamp > b.timestamp) return 1;
            if (a.timestamp < b.timestamp) return -1;
            return 0;
        });

        try {
            const cwPutLogEvents = await cloudWatchLogs.putLogEvents(putLogEventParams).promise();
            console.log(`Success in putting ${putLogEventParams.logEvents.length} events`);
            return cwPutLogEvents.nextSequenceToken
        } catch (err) {
            console.log('Error during put log events: ', err, err.stack);
            return sequenceToken;
        }
    }

    async function sendBatches(batches, batch) {
        batches.push(batch);
        console.log(`Finished batching, pushing ${batches.length} batches to CloudWatch`);
        let seqToken = sequenceToken;
        for (let i = 0; i < batches.length; i++) {
            const batch = batches[i];
            var count = 0;
            var batch_count = 0;
            try {
                seqToken = await sendBatch(batch, seqToken);
                ++batch_count;
                count += batch.length;
            } catch (err) {
                console.log('Error sending batch: ', err, err.stack);
                continue;
            }
        }
        console.log(`Successfully put ${count} events in ${batch_count} batches`);
    }

    async function getS3Object(Bucket, Key) {
        console.log(`Retrieving ${Bucket}${Key}`);
        return await s3.getObject({
            Bucket,
            Key,
        }).promise();
    }

    async function unpackLogData(s3object) {
        console.log(`Unpacking log data for ${loadBalancerType} load balancer`);
        if (loadBalancerType === "classic") return s3object.Body.toString('ascii')
        else {
            const uncompressedLogBuffer = await gunzipAsync(s3object.Body);
            return uncompressedLogBuffer.toString('ascii');
        }
    }

    async function createLogGroupIfNotExists() {
        console.log(`Checking Log Group ${logGroupName} exists`);
        const result = await cloudWatchLogs.describeLogGroups({
            logGroupNamePrefix: logGroupName,
        }).promise();
        if (!result.logGroups[0]) {
            console.log(`${logGroupName} exists`);
            await cloudWatchLogs.createLogGroup({
                logGroupName,
            }).promise();
        }
    }

    async function getLogStreamSequenceToken() {
        console.log(`Checking Log Streams ${logGroupName}/${logStreamName}`);
        let currentStream;
        const cwlDescribeStreams = await cloudWatchLogs.describeLogStreams({
            logGroupName,
            logStreamNamePrefix: logStreamName
        }).promise();

        if (cwlDescribeStreams.logStreams[0]) currentStream = cwlDescribeStreams.logStreams[0]
        else {
            console.log(`Creating Log Stream ${logGroupName}/${logStreamName}`);
            await cloudWatchLogs.createLogStream({
                logGroupName,
                logStreamName,
            }).promise();
            const cwlDescribeCreatedStream = await cloudWatchLogs.describeLogStreams({
                logGroupName: logGroupName,
                logStreamNamePrefix: logStreamName
            }).promise();
            currentStream = cwlDescribeCreatedStream.logStreams[0];
        }

        return currentStream.uploadSequenceToken;
    }

    rl.on('line', readLines);
    rl.on('close', sendBatches);
};