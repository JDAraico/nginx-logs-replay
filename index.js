#!/usr/bin/env node
const Moment = require('moment');
const fs = require('fs');
const NginxParser = require('nginxparser');
const axios = require('axios').default;
const axiosRetry = require('axios-retry');
const https = require('https');
const Winston = require('winston');
const {program} = require('commander');
const rl = require("readline");
const Stats = require('fast-stats').Stats;
const _ = require('lodash');

program.version(process.env.npm_package_version);

const defaultFormat = '$remote_addr [$time_local] "$request" $status $body_bytes_sent req_time:$request_time req_body:$req_body resp_body:$resp_body\treq_headers:{$request_headers} resp_headers:{$resp_headers}';
const defaultFormatTime = 'DD/MMM/YYYY:HH:mm:ss Z';

program
    .requiredOption('-f, --filePath <path>', 'path of the nginx logs file')
    .requiredOption('-p, --prefix <url>', 'url for sending requests')
    .option('-r, --ratio <number>', 'acceleration / deceleration rate of sending requests, eg: 2, 0.5', '1')
    .option('--format <string>', 'format of the nginx log', defaultFormat)
    .option('--formatTime <string>', 'format of the nginx time', defaultFormatTime)
    .option('--startTimestamp <number>', 'start replaying logs from this timestamp', '0')
    .option('-d --debug', 'show debug messages in console', false)
    .option('-l, --logFile <path>', 'save results to the logs file', '')
    .option('-t, --timeout <int>', 'timeout fo the requests')
    .option('--username <string>', 'username for basic auth')
    .option('--password <string>', 'password  for basic auth')
    .option('--scaleMode', 'experimental mode for the changing requests order', false)
    .option('--skipSleep', 'remove pauses between requests. Attention: will ddos your server', false)
    .option('--skipSsl', 'skip ssl errors', false)
    .option('--datesFormat <string>', 'format of dates to display in logs (regarding Moment.js parsing format)', "DD-MM-YYYY:HH:mm:ss")
    .option('-s, --stats', 'show stats of the requests', false)
    .option('--deleteQueryStats [strings...]', 'delete some query for calculating stats, eg: "page limit size"', [])
    .option('--statsOnlyPath', 'keep only endpoints for showing stats', false)
    .option('--filterOnly [strings...]', 'filter logs for replaying, eg: "/test data .php"', [])
    .option('--filterSkip [strings...]', 'skip logs for replaying, eg: "/test data .php"', [])
    .option('--customQueryParams [strings...]', 'additional query params fro requests, eg: "test=true size=3"', [])
    .option('--hideStatsLimit <int>', 'limit number of stats', '0')
    .option('--summary', 'summary log', false);

program.parse(process.argv);
const args = program.opts();
Object.entries(args).forEach(arg => {
    if (typeof arg[1] === "string" && arg[1].startsWith('=')) args[arg[0]] = arg[1].replace('=', '');
})

const parser = new NginxParser(args.format);
const debugLogger = Winston.createLogger({
    format: Winston.format.simple(),
    silent: !args.debug,
    transports: [
        new Winston.transports.Console(),
    ]
});

const mainLogger = Winston.createLogger({
    format: Winston.format.simple(),
    transports: [
        new Winston.transports.Console(),
    ]
});

let resultLoggerTransports = [
    new Winston.transports.Console({
        level: 'info',
        format: Winston.format.combine(
            Winston.format.colorize(),
            Winston.format.printf(
                (info) => {
                    return `${info.message}`;
                })
        )
    }),
];
if (args.logFile !== '') {
    resultLoggerTransports.push(new Winston.transports.File({
        filename: args.logFile,
        level: 'info',
        format: Winston.format.combine(
            Winston.format.colorize(),
            Winston.format.printf(
                (info) => {
                    return `${info.message}`;
                })
        )
    }));
}

const resultLogger = Winston.createLogger({
    format: Winston.format.simple(),
    transports: resultLoggerTransports,
});


let summaryLoggerTransports = [
    new Winston.transports.Console({
        level: 'info',
        format: Winston.format.combine(
            Winston.format.colorize(),
            Winston.format.printf(
                (info) => {
                    return `${info.message}`;
                })
        )
    }),
];
if (args.logFile !== '' && args.summary) {
    summaryLoggerTransports.push(new Winston.transports.File({
        filename: args.logFile + '_summary',
        level: 'info',
        format: Winston.format.combine(
            Winston.format.colorize(),
            Winston.format.printf(
                (info) => {
                    return `${info.message}`;
                })
        )
    }));
}

const summaryLogger = Winston.createLogger({
    format: Winston.format.simple(),
    transports: summaryLoggerTransports,
});

axiosRetry(axios, {
    retries: 1000000, // number of retries
    retryDelay: (retryCount) => {
        resultLogger.info(`retry attempt: ${retryCount}`);
        return retryCount * 2000; // time interval between retries
    },
    retryCondition: (error) => {
        // if retry condition is not specified, by default idempotent requests are retried
        return error.response.status === 503;
    },
});

const dataArray = [];
let numberOfSuccessfulEvents = 0;
let numberOfFailedEvents = 0;
let numberOfSkippedEvents = 0;
let numberOfHeaderDiscrepancies = 0;
let numberOfBodyDiscrepancies = 0;
let totalResponseTime = 0;
let startTime = 0;
let finishTime = 0;
let totalSleepTime = 0;
let numStats = new Stats();
let statsMongoTime = new Stats();
let statsMongoTxFullTime = new Stats();
let statsMongoTxFastTime = new Stats();

let statsRedisReadNumber = new Stats();
let statsRedisReadTime = new Stats();
let statsRedisWriteNumber = new Stats();
let statsRedisWriteTime = new Stats();
let statsEthNodeNumber = new Stats();
let statsEthNodeTime = new Stats();

let statsClickHouseTime = new Stats();

let statsPHPTime = new Stats();

const deleteQuery = args.deleteQueryStats;
const stats = {};

fs.access(args.filePath, fs.F_OK, (err) => {
    if (err) {
        mainLogger.error(`Cannot find file ${args.filePath}`);
        process.exit(1);
    }
});

if (args.logFile) {
    if (args.logFile === args.filePath) {
        mainLogger.error(`logFile can not be equal to filePath`);
        process.exit(1);
    }
    if (fs.existsSync(args.logFile)) fs.unlinkSync(args.logFile);
}

const secondsRepeats = {};
let currentTimestamp = 0;

//Display results info in case of interruption
if (process.platform === "win32") {
    rl.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    rl.on("SIGINT", () => {
        process.emit("SIGINT");
    });
}

process.on("SIGINT", () => {
    if (currentTimestamp>0) mainLogger.info(`Interrupted at timestamp ${currentTimestamp}`);
    generateReport();
    process.exit();
});

args.startTimestamp = args.startTimestamp.length>10? args.startTimestamp: args.startTimestamp*1000;
const startProcessTime = new Date();
parser.read(args.filePath, function (row) {
    const timestamp = Moment(row.time_local, args.formatTime).unix() * 1000;
    let isFilterSkip = false;
    args.filterSkip.forEach(filter => {
        if (row.request.includes(filter)) isFilterSkip = true;
    });
    let isFilterOnly = args.filterOnly.length === 0? true:false;
    args.filterOnly.forEach(filter => {
        if (row.request.includes(filter)) isFilterOnly = true;
    });
    if (timestamp>args.startTimestamp && isFilterOnly && !isFilterSkip){
        dataArray.push({
            agent: row.http_user_agent,
            status: row.status,
            req: row.request,
            body: row.req_body,
            headers: row.request_headers,
            timestamp,
            resp_body: row.resp_body,
            resp_headers: row.resp_headers,
            request_time: row.request_time
        });
        if (args.scaleMode) {
            secondsRepeats[timestamp] ? secondsRepeats[timestamp] += 1 : secondsRepeats[timestamp] = 1;
        }
    }
}, async function (err) {
    if (err) throw err;
    startTime = +new Date();
    if (dataArray.length===0) mainLogger.info(`No logs for the replaying`);
    for (let i = 0; i < dataArray.length; i++) {
        if (dataArray[i].status != '500' && dataArray[i].status != '499') {
        const now = +new Date();
        finishTime = now;
        let requestMethod = dataArray[i].req.split(" ")[0];
        let requestUrl;
        if (args.customQueryParams.length!==0){
            requestUrl = new URL(args.prefix + dataArray[i].req.split(" ")[1]);
            args.customQueryParams.forEach(queryParam=>{
                requestUrl.searchParams.delete(queryParam.split('=')[0]);
                requestUrl.searchParams.append(queryParam.split('=')[0],queryParam.split('=')[1]);
            });
            requestUrl = requestUrl.toString().replace(args.prefix, "");
        }else{
            requestUrl = dataArray[i].req.split(" ")[1];
        }
            
        if(requestUrl.includes('artifacts'))
           continue;
            
        debugLogger.info(`Sending ${requestMethod} request to ${requestUrl} at ${now}`);
        if (args.stats) {
            let statsUrl = new URL(args.prefix + requestUrl);
            if (args.statsOnlyPath) {
                statsUrl = statsUrl.pathname;
            } else {
                deleteQuery.forEach(query => statsUrl.searchParams.delete(query));
                statsUrl = statsUrl.toString().replace(args.prefix, "");
            }
            stats[statsUrl] ? stats[statsUrl] += 1 : stats[statsUrl] = 1;
        }
        currentTimestamp=dataArray[i].timestamp;
        await sendRequest(requestMethod, requestUrl, now, dataArray[i].agent, dataArray[i].status, dataArray[i].body, dataArray[i].headers, dataArray[i].timestamp, dataArray[i].resp_body, dataArray[i].resp_headers, dataArray[i].request_time);
        
        if (!args.skipSleep && dataArray[i].timestamp !== dataArray[dataArray.length - 1].timestamp) {
            if (args.scaleMode) {
                const timeToSleep = (Number((1000 / secondsRepeats[dataArray[i].timestamp]).toFixed(0)) +
                    (dataArray[i].timestamp === dataArray[i + 1].timestamp ? 0 : (dataArray[i + 1].timestamp - dataArray[i].timestamp - 1000))) / args.ratio;
                totalSleepTime += timeToSleep;
                debugLogger.info(`Sleeping ${timeToSleep} ms`);
                await sleep(timeToSleep);
            } else {
                if (dataArray[i].timestamp !== dataArray[i + 1].timestamp) {
                    const timeToSleep = ((dataArray[i + 1].timestamp - dataArray[i].timestamp) / args.ratio);
                    debugLogger.info(`Sleeping ${timeToSleep} ms`);
                    totalSleepTime += timeToSleep;
                    await sleep(timeToSleep);
                }
            }
        }
      }
    }
});

function median(values){
    if(values.length ===0) return 0;

    values.sort(function(a,b){
        return a-b;
    });

    var half = Math.floor(values.length / 2);

    if (values.length % 2)
        return values[half];

    return (values[half - 1] + values[half]) / 2.0;
}

function sleep(ms) {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

async function sendRequest(method, url, sendTime, agent, originalStatus, body, headers, timestamp, resp_body, resp_headers, request_time) {
    const httpsAgent = new https.Agent({
        rejectUnauthorized: !args.skipSsl
    });
    let config = {httpsAgent, method, url: args.prefix + url, auth:{}};
    if (args.username) config.auth.username = args.username;
    if (args.password) config.auth.password = args.password;
    if (args.timeout) config.timeout = args.timeout;
    try {
      if (body) config.data = JSON.parse(body);
    } catch(error) {
      resultLogger.info(`original_status:${originalStatus}  ||  replay_status: -  ||  response_discrepancy: ${error}  ||  original_req_time:${request_time}  ||  replay_time: -  ||  replay_url:${url}  ||  Method:${method}  ||  original_resp_body:${(resp_body) ? resp_body : '""'}  ||  replay_resp_body: -  ||  original_resp_headers:{${resp_headers}} ||  replay_resp_headers: -`)
      numberOfFailedEvents += 1;
      if (numberOfFailedEvents + numberOfSuccessfulEvents + numberOfSkippedEvents === dataArray.length) {
        generateReport();
      }
      return;
    }
    headers = JSON.parse('{'+ headers + '}');
    if (headers.host) delete headers.host;
    let len = new TextEncoder().encode(body).length;
    headers['content-length'] = len;
    headers['nginx-replay'] = len;

    if (headers) config.headers = headers;
    if ((originalStatus == '404' && (headers.authorization == undefined || headers.authorization == 'bearer')) || originalStatus.startsWith('50')) {
        resultLogger.info(`original_status:${originalStatus}  ||  replay_status: -  ||  response_discrepancy: -  ||  original_req_time:${request_time}  ||  replay_time: -  ||  replay_url:${url}  ||  Method:${method}  ||  original_resp_body:${(resp_body) ? resp_body : '""'}  ||  replay_resp_body: -  ||  original_resp_headers:{${resp_headers}} ||  replay_resp_headers: -`)
        numberOfSkippedEvents += 1;
        if (numberOfFailedEvents + numberOfSuccessfulEvents + numberOfSkippedEvents === dataArray.length) {
            generateReport();
        }
        return;
    }
    await axios(config)
        .then(function (response) {
            try {
                debugLogger.info(`Response for ${url} with status code ${response.status} done with ${+new Date() - sendTime} ms`)
                let responseTime = +new Date() - sendTime;
                totalResponseTime += responseTime;
                numStats.push(responseTime);
                    if (originalStatus !== response.status.toString()) {
                        debugLogger.info(`Response for ${url} has different status code: ${response.status} and ${originalStatus}`);
                    } else {
                        let originalHeaders = JSON.parse('{' + resp_headers + '}');
                        let headerDiscrepancies = evaluateHeaders(originalHeaders, response.headers);
                        if (headerDiscrepancies.length !== 0) {
                            numberOfFailedEvents += 1;
                            numberOfHeaderDiscrepancies += 1;
                            resultLogger.info(`original_status:${originalStatus}  ||  replay_status:${response.status}  ||  response_discrepancy:Headers - Discrepancies:${JSON.stringify(headerDiscrepancies)}  ||  original_req_time:${request_time}  ||  replay_time:${(responseTime / 1000).toFixed(3)}  ||  replay_url:${url}  ||  Method:${method}  ||  original_resp_body:${(resp_body) ? resp_body : '""'}  ||  replay_resp_body:${(response.data) ? JSON.stringify(response.data) :  ""}  ||  original_resp_headers:{${resp_headers}}  ||  replay_resp_headers:${JSON.stringify(response.headers)}`)
                            return;
                        }
                        if (method != 'POST') {
                            let respBodyObj = [];
                            if (resp_body) 
                                respBodyObj = JSON.parse(resp_body);
                            if ((!_.isEmpty(respBodyObj) || !_.isEmpty(response.data)) && !_.isEqual(respBodyObj, response.data)) {
                                numberOfFailedEvents += 1;
                                numberOfBodyDiscrepancies += 1;
                                let bodyDiscrepancies = _.differenceWith(_.toPairs(respBodyObj), _.toPairs(response.data), _.isEqual);
                                resultLogger.info(`original_status:${originalStatus}  ||  replay_status:${response.status}  ||  response_discrepancy:Body - Discrepancies:${JSON.stringify(bodyDiscrepancies)}  ||  original_req_time:${request_time}  ||  replay_time:${(responseTime / 1000).toFixed(3)}  ||  replay_url:${url}  ||  Method:${method}  ||  original_resp_body:${(resp_body) ? resp_body : '""'}  ||  replay_resp_body:${(response.data) ? JSON.stringify(response.data) :  ""}  ||  original_resp_headers:{${resp_headers}}  ||  replay_resp_headers:${JSON.stringify(response.headers)}`)
                                return;
                            }
                        }
                        numberOfSuccessfulEvents += 1;
                    }

                    if (response.data.debug){
                        if (response.data.debug.mongo) statsMongoTime.push(response.data.debug.mongo);
                        if (response.data.debug.mongoTxFast) statsMongoTxFastTime.push(response.data.debug.mongoTxFast);
                        if (response.data.debug.mongoTxFull) statsMongoTxFullTime.push(response.data.debug.mongoTxFull);
                        if (response.data.debug.clickhouse) statsClickHouseTime.push(response.data.debug.clickhouse);
                        if (response.data.debug.php) statsPHPTime.push(response.data.debug.php);
                        if (response.data.debug.redis){
                            if (response.data.debug.redis.read_num) statsRedisReadNumber.push(response.data.debug.redis.read_num);
                            if (response.data.debug.redis.read_time) statsRedisReadTime.push(response.data.debug.redis.read_time);
                            if (response.data.debug.redis.write_num) statsRedisWriteNumber.push(response.data.debug.redis.write_num);
                            if (response.data.debug.redis.write_time) statsRedisWriteTime.push(response.data.debug.redis.write_time);
                        }
                        if (response.data.debug.eth_node){
                            if (response.data.debug.eth_node.num) statsEthNodeNumber.push(response.data.debug.eth_node.num);
                            if (response.data.debug.eth_node.time) statsEthNodeTime.push(response.data.debug.eth_node.time);
                        }
                    }
                    resultLogger.info(`original_status:${originalStatus}  ||  replay_status:${response.status}  ||  response_discrepancy: -  ||  original_req_time:${request_time}  ||  replay_time:${(responseTime / 1000).toFixed(3)}  ||  replay_url:${url}  ||  Method:${method}  ||  original_resp_body:${(resp_body) ? resp_body : '""'}  ||  replay_resp_body:${(response.data) ? JSON.stringify(response.data) :  ""}  ||  original_resp_headers:{${resp_headers}}  ||  replay_resp_headers:${JSON.stringify(response.headers)}`)
            }
            catch(error) {
                numberOfFailedEvents += 1;
                let responseTime = +new Date() - sendTime;
                totalResponseTime += responseTime;
                numStats.push(responseTime);
                resultLogger.info(`original_status:${originalStatus}  ||  replay_status: ${(response.status === undefined) ? '-' : response.status}  ||  response_discrepancy: ${error}  ||  original_req_time:${request_time}  ||  replay_time: ${(responseTime === undefined) ? '-' : (responseTime / 1000).toFixed(3)}  ||  replay_url:${url}  ||  Method:${method}  ||  original_resp_body:${(resp_body) ? resp_body : '""'}  ||  replay_resp_body: ${(response.data === undefined) ? '-' : JSON.stringify(response.data)}  ||  original_resp_headers:{${resp_headers}}  ||  replay_resp_headers: ${(response.headers === undefined) ? '-' : JSON.stringify(response.headers)}`)
            }
        })
        .catch(function (error) {
            if (!error.response) {
                mainLogger.error(`Invalid request to ${url} : ${error}`)
                let responseTime = +new Date() - sendTime;
                totalResponseTime += responseTime;
                numStats.push(responseTime);
                if (response) {
                    resultLogger.info(`original_status:${originalStatus}  ||  replay_status: ${(response.status === undefined) ? '-' : response.status}  ||  response_discrepancy: ${error}  ||  original_req_time:${request_time}  ||  replay_time: ${(responseTime === undefined) ? '-' : (responseTime / 1000).toFixed(3)}  ||  replay_url:${url}  ||  Method:${method}  ||  original_resp_body:${(resp_body) ? resp_body : '""'}  ||  replay_resp_body: ${(response.data === undefined) ? '-' : JSON.stringify(response.data)}  ||  original_resp_headers:{${resp_headers}}  ||  replay_resp_headers: ${(response.headers === undefined) ? '-' : JSON.stringify(response.headers)}`)
                }
                else {
                    resultLogger.info(`original_status:${originalStatus}  ||  replay_status: -  ||  response_discrepancy: ${error}  ||  original_req_time:${request_time}  ||  replay_time: -  ||  replay_url:${url}  ||  Method:${method}  ||  original_resp_body:${(resp_body) ? resp_body : '""'}  ||  replay_resp_body: -  ||  original_resp_headers:{${resp_headers}}  ||  replay_resp_headers: -`)
                }
                numberOfFailedEvents += 1;
            } else {
                if (originalStatus !== error.response.status.toString()) {
                    debugLogger.info(`Response for ${url} has different status code: ${error.response.status} and ${originalStatus}`);
                    numberOfFailedEvents += 1;
                } else {
                    numberOfSuccessfulEvents += 1;
                }
                let responseTime = +new Date() - sendTime;
                totalResponseTime += responseTime;
                numStats.push(responseTime);
                if (error.response.data.debug){
                    if (error.response.data.debug.mongo) statsMongoTime.push(error.response.data.debug.mongo);
                    if (error.response.data.debug.mongoTxFull) statsMongoTxFullTime.push(error.response.data.debug.mongoTxFull);
                    if (error.response.data.debug.mongoTxFast) statsMongoTxFastTime.push(error.response.data.debug.mongoTxFast);
                    if (error.response.data.debug.clickhouse) statsClickHouseTime.push(error.response.data.debug.clickhouse);
                    if (error.response.data.debug.php) statsPHPTime.push(error.response.data.debug.php);
                    if (error.response.data.debug.redis){
                        if (error.response.data.debug.redis.read_num) statsRedisReadNumber.push(error.response.data.debug.redis.read_num);
                        if (error.response.data.debug.redis.read_time) statsRedisReadTime.push(error.response.data.debug.redis.read_time);
                        if (error.response.data.debug.redis.write_num) statsRedisWriteNumber.push(error.response.data.debug.redis.write_num);
                        if (error.response.data.debug.redis.write_time) statsRedisWriteTime.push(error.response.data.debug.redis.write_time);
                    }
                    if (error.response.data.debug.eth_node){
                        if (error.response.data.debug.eth_node.num) statsEthNodeNumber.push(error.response.data.debug.eth_node.num);
                        if (error.response.data.debug.eth_node.time) statsEthNodeTime.push(error.response.data.debug.eth_node.time);
                    }
                }
                resultLogger.info(`original_status:${originalStatus}  ||  replay_status:${error.response.status}  ||  response_discrepancy: ${error}  ||  original_req_time:${request_time}  ||  replay_time:${(responseTime / 1000).toFixed(3)}  ||  replay_url:${url}  ||  Method:${method}  ||  original_resp_body:${(resp_body) ? resp_body : '""'}  ||  replay_resp_body:${JSON.stringify(error.response.data)}  ||  original_resp_headers:{${resp_headers}}  ||  replay_resp_headers:${JSON.stringify(error.response.headers)}`)
            }
        }).then(function () {
        if (numberOfFailedEvents + numberOfSuccessfulEvents + numberOfSkippedEvents === dataArray.length) {
            generateReport();
        }
    });
}

function getPercentile(stat, toSeconds=false){
    const percentiles = [1,5,25,50,75,95,99];
    let percentilesObject = {};
    percentiles.forEach(percentile=>{
        percentilesObject[percentile] = (stat.percentile(percentile)/(toSeconds?1000:1)).toFixed(3)
    });
    return percentilesObject;
}

function getResponseTime(stat, toSeconds=false, toFixed=3){
    return {minimum:(stat.range()[0]/(toSeconds?1000:1)).toFixed(toFixed),
        maximum:(stat.range()[1]/(toSeconds?1000:1)).toFixed(toFixed),
        average: (stat.amean()/(toSeconds?1000:1)).toFixed(3),
        total: (stat.sum/(toSeconds?1000:1)).toFixed(toFixed),
        number: stat.length};
}

function generateReport(){
    mainLogger.info('___________________________________________________________________________');
    mainLogger.info(`Host: ${args.prefix}. Start time: ${startProcessTime.toISOString()}. Finish time: ${(new Date()).toISOString()}. Options: ${args.customQueryParams}`);
    mainLogger.info(`Total number of requests: ${numberOfSuccessfulEvents+numberOfFailedEvents+numberOfSkippedEvents}. Number of the failed requests: ${numberOfFailedEvents}. Number of skipped requests: ${numberOfSkippedEvents}. Percent of the successful requests: ${(100 * numberOfSuccessfulEvents / (numberOfSuccessfulEvents+numberOfFailedEvents+numberOfSkippedEvents)).toFixed(2)}%.`);
    mainLogger.info(`Response time: ${JSON.stringify(getResponseTime(numStats,true))}`);
    mainLogger.info(`Percentile: ${JSON.stringify(getPercentile(numStats, true))}`);
    if (statsPHPTime.length!==0) mainLogger.info(`PHP response time: ${JSON.stringify(getResponseTime(statsPHPTime, false))}`);
    if (statsPHPTime.length!==0) mainLogger.info(`PHP percentile: ${JSON.stringify(getPercentile(statsPHPTime))}`);
    if (statsMongoTime.length!==0) mainLogger.info(`Mongo response time: ${JSON.stringify(getResponseTime(statsMongoTime, false))}`);
    if (statsMongoTime.length!==0) mainLogger.info(`Mongo percentile: ${JSON.stringify(getPercentile(statsMongoTime))}`);
    if (statsClickHouseTime.length!==0) mainLogger.info(`ClickHouse response time: ${JSON.stringify(getResponseTime(statsClickHouseTime, false))}`);
    if (statsClickHouseTime.length!==0) mainLogger.info(`ClickHouse percentile: ${JSON.stringify(getPercentile(statsClickHouseTime))}`);
    if (statsMongoTxFastTime.length!==0) mainLogger.info(`Mongo txFast response time: ${JSON.stringify(getResponseTime(statsMongoTxFastTime, false))}`);
    if (statsMongoTxFastTime.length!==0) mainLogger.info(`Mongo txFast percentile: ${JSON.stringify(getPercentile(statsMongoTxFastTime))}`);
    if (statsMongoTxFullTime.length!==0) mainLogger.info(`Mongo txFull response time: ${JSON.stringify(getResponseTime(statsMongoTxFullTime, false))}`);
    if (statsMongoTxFullTime.length!==0) mainLogger.info(`Mongo txFull percentile: ${JSON.stringify(getPercentile(statsMongoTxFullTime))}`);
    if (statsRedisReadTime.length!==0) mainLogger.info(`Redis read time: ${JSON.stringify(getResponseTime(statsRedisReadTime, false))}`);
    if (statsRedisReadTime.length!==0) mainLogger.info(`Redis read percentile: ${JSON.stringify(getPercentile(statsRedisReadTime))}`);
    if (statsRedisReadNumber.length!==0) mainLogger.info(`Redis read count: ${JSON.stringify(getResponseTime(statsRedisReadNumber, false,0))}`);
    if (statsRedisWriteTime.length!==0) mainLogger.info(`Redis write time: ${JSON.stringify(getResponseTime(statsRedisWriteTime, false))}`);
    if (statsRedisWriteTime.length!==0) mainLogger.info(`Redis write percentile: ${JSON.stringify(getPercentile(statsRedisWriteTime))}`);
    if (statsRedisWriteNumber.length!==0) mainLogger.info(`Redis write count: ${JSON.stringify(getResponseTime(statsRedisWriteNumber, false,0))}`);
    if (statsEthNodeTime.length!==0) mainLogger.info(`Eth node time: ${JSON.stringify(getResponseTime(statsEthNodeTime, false))}`);
    if (statsEthNodeTime.length!==0) mainLogger.info(`Eth node percentile: ${JSON.stringify(getPercentile(statsEthNodeTime))}`);
    if (statsEthNodeNumber.length!==0) mainLogger.info(`Eth node count: ${JSON.stringify(getResponseTime(statsEthNodeNumber, false,0))}`);
    mainLogger.info(`Total requests time: ${(finishTime - startTime) / 1000} seconds. Total sleep time: ${(totalSleepTime / 1000).toFixed(2)} seconds.`);
    mainLogger.info(`Original time: ${(dataArray[dataArray.length - 1].timestamp - dataArray[0].timestamp) / 1000} seconds. Original rps: ${(1000 * dataArray.length / (dataArray[dataArray.length - 1].timestamp - dataArray[0].timestamp)).toFixed(4)}. Replay rps: ${((numberOfSuccessfulEvents+numberOfFailedEvents) * 1000 / (finishTime - startTime)).toFixed(4)}. Ratio: ${args.ratio}.`);
    if (args.stats) {
        const hiddenStats = {};
        let sortedStats = Object.keys(stats).sort((a, b) => stats[b] - stats[a]);
        mainLogger.info('___________________________________________________________________________');
        mainLogger.info('Stats results:');
        sortedStats.forEach(x => {
            if (stats[x] > args.hideStatsLimit) {
                mainLogger.info(`${x} : ${stats[x]}`)
            } else {
                hiddenStats[stats[x]] ? hiddenStats[stats[x]] += 1 : hiddenStats[stats[x]] = 1;
            }
        });
        if (Object.keys(hiddenStats) > 0) mainLogger.info(`Hidden stats: ${JSON.stringify(hiddenStats)}`);
    }

    if(args.summary) {
        summaryLogger.info('___________________________________________________________________________');
        summaryLogger.info(`Host: ${args.prefix}. Start time: ${startProcessTime.toISOString()}. Finish time: ${(new Date()).toISOString()}. Options: ${args.customQueryParams}`);
        summaryLogger.info(`Total number of requests: ${numberOfSuccessfulEvents+numberOfFailedEvents+numberOfSkippedEvents}. Number of failed requests (different status): ${numberOfFailedEvents}. Number of skipped requests: ${numberOfSkippedEvents}. Percent of the successful requests: ${(100 * numberOfSuccessfulEvents / (numberOfSuccessfulEvents+numberOfFailedEvents+numberOfSkippedEvents)).toFixed(2)}%.`);
        summaryLogger.info(`Total number of discrepancies: ${numberOfBodyDiscrepancies+numberOfHeaderDiscrepancies}. Number of Body discrepancies: ${numberOfBodyDiscrepancies}. Number of Header discrepancies: ${numberOfHeaderDiscrepancies}.`);
        summaryLogger.info(`Response time: ${JSON.stringify(getResponseTime(numStats,true))}`);
        summaryLogger.info(`Percentile: ${JSON.stringify(getPercentile(numStats, true))}`);

        summaryLogger.info(`Total requests time: ${(finishTime - startTime) / 1000} seconds. Total sleep time: ${(totalSleepTime / 1000).toFixed(2)} seconds.`);
        summaryLogger.info(`Original time: ${(dataArray[dataArray.length - 1].timestamp - dataArray[0].timestamp) / 1000} seconds. Original rps: ${(1000 * dataArray.length / (dataArray[dataArray.length - 1].timestamp - dataArray[0].timestamp)).toFixed(4)}. Replay rps: ${((numberOfSuccessfulEvents+numberOfFailedEvents) * 1000 / (finishTime - startTime)).toFixed(4)}. Ratio: ${args.ratio}.`);
        if (args.stats) {
            const hiddenStats = {};
            let sortedStats = Object.keys(stats).sort((a, b) => stats[b] - stats[a]);
            summaryLogger.info('___________________________________________________________________________');
            summaryLogger.info('Stats results:');
            sortedStats.forEach(x => {
                if (stats[x] > args.hideStatsLimit) {
                    summaryLogger.info(`${x} : ${stats[x]}`)
                } else {
                    hiddenStats[stats[x]] ? hiddenStats[stats[x]] += 1 : hiddenStats[stats[x]] = 1;
                }
            });
            if (Object.keys(hiddenStats) > 0) summaryLogger.info(`Hidden stats: ${JSON.stringify(hiddenStats)}`);
        }
    }
}
function evaluateHeaders(originalHeaders, replayedHeaders){
    let discrepancies = [];
    if (originalHeaders["x-continuation-token"])
        if (originalHeaders["x-continuation-token"] != replayedHeaders["x-continuation-token"])
            discrepancies.push("x-continuation-token");

    if (originalHeaders["content-type"])
        if (originalHeaders["content-type"] != replayedHeaders["content-type"])
            discrepancies.push("content-type");

    if ((originalHeaders["location"] && !replayedHeaders["location"]) || (!originalHeaders["location"] && replayedHeaders["location"]))
        discrepancies.push("location");

    if (originalHeaders["x-total-count"])
        if (originalHeaders["x-total-count"] != replayedHeaders["x-total-count"])
            discrepancies.push("x-total-count");

  return discrepancies;
}
