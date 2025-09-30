import * as crypto from "crypto";
import * as fs from "fs";
import * as http from "http";
import * as https from "https";
import * as path from "path";
import * as stream from "stream";
import * as async from 'async';
import BlockStream2 from 'block-stream2';
import { isBrowser } from 'browser-or-node';
import _ from 'lodash';
import * as qs from 'query-string';
import xml2js from 'xml2js';
import { CredentialProvider } from "../CredentialProvider.mjs";
import * as errors from "../errors.mjs";
import { CopyDestinationOptions, CopySourceOptions, DEFAULT_REGION, LEGAL_HOLD_STATUS, PRESIGN_EXPIRY_DAYS_MAX, RETENTION_MODES, RETENTION_VALIDITY_UNITS } from "../helpers.mjs";
import { postPresignSignatureV4, presignSignatureV4, signV4 } from "../signing.mjs";
import { fsp, streamPromise } from "./async.mjs";
import { CopyConditions } from "./copy-conditions.mjs";
import { Extensions } from "./extensions.mjs";
import { calculateEvenSplits, extractMetadata, getContentLength, getScope, getSourceVersionId, getVersionId, hashBinary, insertContentType, isAmazonEndpoint, isBoolean, isDefined, isEmpty, isNumber, isObject, isPlainObject, isReadableStream, isString, isValidBucketName, isValidEndpoint, isValidObjectName, isValidPort, isValidPrefix, isVirtualHostStyle, makeDateLong, PART_CONSTRAINTS, partsRequired, prependXAMZMeta, readableStream, sanitizeETag, toMd5, toSha256, uriEscape, uriResourceEscape } from "./helper.mjs";
import { joinHostPort } from "./join-host-port.mjs";
import { PostPolicy } from "./post-policy.mjs";
import { requestWithRetry } from "./request.mjs";
import { drainResponse, readAsBuffer, readAsString } from "./response.mjs";
import { getS3Endpoint } from "./s3-endpoints.mjs";
import { parseCompleteMultipart, parseInitiateMultipart, parseListObjects, parseObjectLegalHoldConfig, parseSelectObjectContentResponse, uploadPartParser } from "./xml-parser.mjs";
import * as xmlParsers from "./xml-parser.mjs";
const xml = new xml2js.Builder({
  renderOpts: {
    pretty: false
  },
  headless: true
});

// will be replaced by bundler.
const Package = {
  version: "8.0.6" || 'development'
};
const requestOptionProperties = ['agent', 'ca', 'cert', 'ciphers', 'clientCertEngine', 'crl', 'dhparam', 'ecdhCurve', 'family', 'honorCipherOrder', 'key', 'passphrase', 'pfx', 'rejectUnauthorized', 'secureOptions', 'secureProtocol', 'servername', 'sessionIdContext'];
export class TypedClient {
  partSize = 64 * 1024 * 1024;
  maximumPartSize = 5 * 1024 * 1024 * 1024;
  maxObjectSize = 5 * 1024 * 1024 * 1024 * 1024;
  constructor(params) {
    // @ts-expect-error deprecated property
    if (params.secure !== undefined) {
      throw new Error('"secure" option deprecated, "useSSL" should be used instead');
    }
    // Default values if not specified.
    if (params.useSSL === undefined) {
      params.useSSL = true;
    }
    if (!params.port) {
      params.port = 0;
    }
    // Validate input params.
    if (!isValidEndpoint(params.endPoint)) {
      throw new errors.InvalidEndpointError(`Invalid endPoint : ${params.endPoint}`);
    }
    if (!isValidPort(params.port)) {
      throw new errors.InvalidArgumentError(`Invalid port : ${params.port}`);
    }
    if (!isBoolean(params.useSSL)) {
      throw new errors.InvalidArgumentError(`Invalid useSSL flag type : ${params.useSSL}, expected to be of type "boolean"`);
    }

    // Validate region only if its set.
    if (params.region) {
      if (!isString(params.region)) {
        throw new errors.InvalidArgumentError(`Invalid region : ${params.region}`);
      }
    }
    const host = params.endPoint.toLowerCase();
    let port = params.port;
    let protocol;
    let transport;
    let transportAgent;
    // Validate if configuration is not using SSL
    // for constructing relevant endpoints.
    if (params.useSSL) {
      // Defaults to secure.
      transport = https;
      protocol = 'https:';
      port = port || 443;
      transportAgent = https.globalAgent;
    } else {
      transport = http;
      protocol = 'http:';
      port = port || 80;
      transportAgent = http.globalAgent;
    }

    // if custom transport is set, use it.
    if (params.transport) {
      if (!isObject(params.transport)) {
        throw new errors.InvalidArgumentError(`Invalid transport type : ${params.transport}, expected to be type "object"`);
      }
      transport = params.transport;
    }

    // if custom transport agent is set, use it.
    if (params.transportAgent) {
      if (!isObject(params.transportAgent)) {
        throw new errors.InvalidArgumentError(`Invalid transportAgent type: ${params.transportAgent}, expected to be type "object"`);
      }
      transportAgent = params.transportAgent;
    }

    // User Agent should always following the below style.
    // Please open an issue to discuss any new changes here.
    //
    //       MinIO (OS; ARCH) LIB/VER APP/VER
    //
    const libraryComments = `(${process.platform}; ${process.arch})`;
    const libraryAgent = `MinIO ${libraryComments} minio-js/${Package.version}`;
    // User agent block ends.

    this.transport = transport;
    this.transportAgent = transportAgent;
    this.host = host;
    this.port = port;
    this.protocol = protocol;
    this.userAgent = `${libraryAgent}`;

    // Default path style is true
    if (params.pathStyle === undefined) {
      this.pathStyle = true;
    } else {
      this.pathStyle = params.pathStyle;
    }
    this.accessKey = params.accessKey ?? '';
    this.secretKey = params.secretKey ?? '';
    this.sessionToken = params.sessionToken;
    this.anonymous = !this.accessKey || !this.secretKey;
    if (params.credentialsProvider) {
      this.anonymous = false;
      this.credentialsProvider = params.credentialsProvider;
    }
    this.regionMap = {};
    if (params.region) {
      this.region = params.region;
    }
    if (params.partSize) {
      this.partSize = params.partSize;
      this.overRidePartSize = true;
    }
    if (this.partSize < 5 * 1024 * 1024) {
      throw new errors.InvalidArgumentError(`Part size should be greater than 5MB`);
    }
    if (this.partSize > 5 * 1024 * 1024 * 1024) {
      throw new errors.InvalidArgumentError(`Part size should be less than 5GB`);
    }

    // SHA256 is enabled only for authenticated http requests. If the request is authenticated
    // and the connection is https we use x-amz-content-sha256=UNSIGNED-PAYLOAD
    // header for signature calculation.
    this.enableSHA256 = !this.anonymous && !params.useSSL;
    this.s3AccelerateEndpoint = params.s3AccelerateEndpoint || undefined;
    this.reqOptions = {};
    this.clientExtensions = new Extensions(this);
  }
  /**
   * Minio extensions that aren't necessary present for Amazon S3 compatible storage servers
   */
  get extensions() {
    return this.clientExtensions;
  }

  /**
   * @param endPoint - valid S3 acceleration end point
   */
  setS3TransferAccelerate(endPoint) {
    this.s3AccelerateEndpoint = endPoint;
  }

  /**
   * Sets the supported request options.
   */
  setRequestOptions(options) {
    if (!isObject(options)) {
      throw new TypeError('request options should be of type "object"');
    }
    this.reqOptions = _.pick(options, requestOptionProperties);
  }

  /**
   *  This is s3 Specific and does not hold validity in any other Object storage.
   */
  getAccelerateEndPointIfSet(bucketName, objectName) {
    if (!isEmpty(this.s3AccelerateEndpoint) && !isEmpty(bucketName) && !isEmpty(objectName)) {
      // http://docs.aws.amazon.com/AmazonS3/latest/dev/transfer-acceleration.html
      // Disable transfer acceleration for non-compliant bucket names.
      if (bucketName.includes('.')) {
        throw new Error(`Transfer Acceleration is not supported for non compliant bucket:${bucketName}`);
      }
      // If transfer acceleration is requested set new host.
      // For more details about enabling transfer acceleration read here.
      // http://docs.aws.amazon.com/AmazonS3/latest/dev/transfer-acceleration.html
      return this.s3AccelerateEndpoint;
    }
    return false;
  }

  /**
   *   Set application specific information.
   *   Generates User-Agent in the following style.
   *   MinIO (OS; ARCH) LIB/VER APP/VER
   */
  setAppInfo(appName, appVersion) {
    if (!isString(appName)) {
      throw new TypeError(`Invalid appName: ${appName}`);
    }
    if (appName.trim() === '') {
      throw new errors.InvalidArgumentError('Input appName cannot be empty.');
    }
    if (!isString(appVersion)) {
      throw new TypeError(`Invalid appVersion: ${appVersion}`);
    }
    if (appVersion.trim() === '') {
      throw new errors.InvalidArgumentError('Input appVersion cannot be empty.');
    }
    this.userAgent = `${this.userAgent} ${appName}/${appVersion}`;
  }

  /**
   * returns options object that can be used with http.request()
   * Takes care of constructing virtual-host-style or path-style hostname
   */
  getRequestOptions(opts) {
    const method = opts.method;
    const region = opts.region;
    const bucketName = opts.bucketName;
    let objectName = opts.objectName;
    const headers = opts.headers;
    const query = opts.query;
    let reqOptions = {
      method,
      headers: {},
      protocol: this.protocol,
      // If custom transportAgent was supplied earlier, we'll inject it here
      agent: this.transportAgent
    };

    // Verify if virtual host supported.
    let virtualHostStyle;
    if (bucketName) {
      virtualHostStyle = isVirtualHostStyle(this.host, this.protocol, bucketName, this.pathStyle);
    }
    let path = '/';
    let host = this.host;
    let port;
    if (this.port) {
      port = this.port;
    }
    if (objectName) {
      objectName = uriResourceEscape(objectName);
    }

    // For Amazon S3 endpoint, get endpoint based on region.
    if (isAmazonEndpoint(host)) {
      const accelerateEndPoint = this.getAccelerateEndPointIfSet(bucketName, objectName);
      if (accelerateEndPoint) {
        host = `${accelerateEndPoint}`;
      } else {
        host = getS3Endpoint(region);
      }
    }
    if (virtualHostStyle && !opts.pathStyle) {
      // For all hosts which support virtual host style, `bucketName`
      // is part of the hostname in the following format:
      //
      //  var host = 'bucketName.example.com'
      //
      if (bucketName) {
        host = `${bucketName}.${host}`;
      }
      if (objectName) {
        path = `/${objectName}`;
      }
    } else {
      // For all S3 compatible storage services we will fallback to
      // path style requests, where `bucketName` is part of the URI
      // path.
      if (bucketName) {
        path = `/${bucketName}`;
      }
      if (objectName) {
        path = `/${bucketName}/${objectName}`;
      }
    }
    if (query) {
      path += `?${query}`;
    }
    reqOptions.headers.host = host;
    if (reqOptions.protocol === 'http:' && port !== 80 || reqOptions.protocol === 'https:' && port !== 443) {
      reqOptions.headers.host = joinHostPort(host, port);
    }
    reqOptions.headers['user-agent'] = this.userAgent;
    if (headers) {
      // have all header keys in lower case - to make signing easy
      for (const [k, v] of Object.entries(headers)) {
        reqOptions.headers[k.toLowerCase()] = v;
      }
    }

    // Use any request option specified in minioClient.setRequestOptions()
    reqOptions = Object.assign({}, this.reqOptions, reqOptions);
    return {
      ...reqOptions,
      headers: _.mapValues(_.pickBy(reqOptions.headers, isDefined), v => v.toString()),
      host,
      port,
      path
    };
  }
  async setCredentialsProvider(credentialsProvider) {
    if (!(credentialsProvider instanceof CredentialProvider)) {
      throw new Error('Unable to get credentials. Expected instance of CredentialProvider');
    }
    this.credentialsProvider = credentialsProvider;
    await this.checkAndRefreshCreds();
  }
  async checkAndRefreshCreds() {
    if (this.credentialsProvider) {
      try {
        const credentialsConf = await this.credentialsProvider.getCredentials();
        this.accessKey = credentialsConf.getAccessKey();
        this.secretKey = credentialsConf.getSecretKey();
        this.sessionToken = credentialsConf.getSessionToken();
      } catch (e) {
        throw new Error(`Unable to get credentials: ${e}`, {
          cause: e
        });
      }
    }
  }
  /**
   * log the request, response, error
   */
  logHTTP(reqOptions, response, err) {
    // if no logStream available return.
    if (!this.logStream) {
      return;
    }
    if (!isObject(reqOptions)) {
      throw new TypeError('reqOptions should be of type "object"');
    }
    if (response && !isReadableStream(response)) {
      throw new TypeError('response should be of type "Stream"');
    }
    if (err && !(err instanceof Error)) {
      throw new TypeError('err should be of type "Error"');
    }
    const logStream = this.logStream;
    const logHeaders = headers => {
      Object.entries(headers).forEach(([k, v]) => {
        if (k == 'authorization') {
          if (isString(v)) {
            const redactor = new RegExp('Signature=([0-9a-f]+)');
            v = v.replace(redactor, 'Signature=**REDACTED**');
          }
        }
        logStream.write(`${k}: ${v}\n`);
      });
      logStream.write('\n');
    };
    logStream.write(`REQUEST: ${reqOptions.method} ${reqOptions.path}\n`);
    logHeaders(reqOptions.headers);
    if (response) {
      this.logStream.write(`RESPONSE: ${response.statusCode}\n`);
      logHeaders(response.headers);
    }
    if (err) {
      logStream.write('ERROR BODY:\n');
      const errJSON = JSON.stringify(err, null, '\t');
      logStream.write(`${errJSON}\n`);
    }
  }

  /**
   * Enable tracing
   */
  traceOn(stream) {
    if (!stream) {
      stream = process.stdout;
    }
    this.logStream = stream;
  }

  /**
   * Disable tracing
   */
  traceOff() {
    this.logStream = undefined;
  }

  /**
   * makeRequest is the primitive used by the apis for making S3 requests.
   * payload can be empty string in case of no payload.
   * statusCode is the expected statusCode. If response.statusCode does not match
   * we parse the XML error and call the callback with the error message.
   *
   * A valid region is passed by the calls - listBuckets, makeBucket and getBucketRegion.
   *
   * @internal
   */
  async makeRequestAsync(options, payload = '', expectedCodes = [200], region = '') {
    if (!isObject(options)) {
      throw new TypeError('options should be of type "object"');
    }
    if (!isString(payload) && !isObject(payload)) {
      // Buffer is of type 'object'
      throw new TypeError('payload should be of type "string" or "Buffer"');
    }
    expectedCodes.forEach(statusCode => {
      if (!isNumber(statusCode)) {
        throw new TypeError('statusCode should be of type "number"');
      }
    });
    if (!isString(region)) {
      throw new TypeError('region should be of type "string"');
    }
    if (!options.headers) {
      options.headers = {};
    }
    if (options.method === 'POST' || options.method === 'PUT' || options.method === 'DELETE') {
      options.headers['content-length'] = payload.length.toString();
    }
    const sha256sum = this.enableSHA256 ? toSha256(payload) : '';
    return this.makeRequestStreamAsync(options, payload, sha256sum, expectedCodes, region);
  }

  /**
   * new request with promise
   *
   * No need to drain response, response body is not valid
   */
  async makeRequestAsyncOmit(options, payload = '', statusCodes = [200], region = '') {
    const res = await this.makeRequestAsync(options, payload, statusCodes, region);
    await drainResponse(res);
    return res;
  }

  /**
   * makeRequestStream will be used directly instead of makeRequest in case the payload
   * is available as a stream. for ex. putObject
   *
   * @internal
   */
  async makeRequestStreamAsync(options, body, sha256sum, statusCodes, region) {
    if (!isObject(options)) {
      throw new TypeError('options should be of type "object"');
    }
    if (!(Buffer.isBuffer(body) || typeof body === 'string' || isReadableStream(body))) {
      throw new errors.InvalidArgumentError(`stream should be a Buffer, string or readable Stream, got ${typeof body} instead`);
    }
    if (!isString(sha256sum)) {
      throw new TypeError('sha256sum should be of type "string"');
    }
    statusCodes.forEach(statusCode => {
      if (!isNumber(statusCode)) {
        throw new TypeError('statusCode should be of type "number"');
      }
    });
    if (!isString(region)) {
      throw new TypeError('region should be of type "string"');
    }
    // sha256sum will be empty for anonymous or https requests
    if (!this.enableSHA256 && sha256sum.length !== 0) {
      throw new errors.InvalidArgumentError(`sha256sum expected to be empty for anonymous or https requests`);
    }
    // sha256sum should be valid for non-anonymous http requests.
    if (this.enableSHA256 && sha256sum.length !== 64) {
      throw new errors.InvalidArgumentError(`Invalid sha256sum : ${sha256sum}`);
    }
    await this.checkAndRefreshCreds();

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    region = region || (await this.getBucketRegionAsync(options.bucketName));
    const reqOptions = this.getRequestOptions({
      ...options,
      region
    });
    if (!this.anonymous) {
      // For non-anonymous https requests sha256sum is 'UNSIGNED-PAYLOAD' for signature calculation.
      if (!this.enableSHA256) {
        sha256sum = 'UNSIGNED-PAYLOAD';
      }
      const date = new Date();
      reqOptions.headers['x-amz-date'] = makeDateLong(date);
      reqOptions.headers['x-amz-content-sha256'] = sha256sum;
      if (this.sessionToken) {
        reqOptions.headers['x-amz-security-token'] = this.sessionToken;
      }
      reqOptions.headers.authorization = signV4(reqOptions, this.accessKey, this.secretKey, region, date, sha256sum);
    }
    const response = await requestWithRetry(this.transport, reqOptions, body);
    if (!response.statusCode) {
      throw new Error("BUG: response doesn't have a statusCode");
    }
    if (!statusCodes.includes(response.statusCode)) {
      // For an incorrect region, S3 server always sends back 400.
      // But we will do cache invalidation for all errors so that,
      // in future, if AWS S3 decides to send a different status code or
      // XML error code we will still work fine.
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      delete this.regionMap[options.bucketName];
      const err = await xmlParsers.parseResponseError(response);
      this.logHTTP(reqOptions, response, err);
      throw err;
    }
    this.logHTTP(reqOptions, response);
    return response;
  }

  /**
   * gets the region of the bucket
   *
   * @param bucketName
   *
   */
  async getBucketRegionAsync(bucketName) {
    if (!isValidBucketName(bucketName)) {
      throw new errors.InvalidBucketNameError(`Invalid bucket name : ${bucketName}`);
    }

    // Region is set with constructor, return the region right here.
    if (this.region) {
      return this.region;
    }
    const cached = this.regionMap[bucketName];
    if (cached) {
      return cached;
    }
    const extractRegionAsync = async response => {
      const body = await readAsString(response);
      const region = xmlParsers.parseBucketRegion(body) || DEFAULT_REGION;
      this.regionMap[bucketName] = region;
      return region;
    };
    const method = 'GET';
    const query = 'location';
    // `getBucketLocation` behaves differently in following ways for
    // different environments.
    //
    // - For nodejs env we default to path style requests.
    // - For browser env path style requests on buckets yields CORS
    //   error. To circumvent this problem we make a virtual host
    //   style request signed with 'us-east-1'. This request fails
    //   with an error 'AuthorizationHeaderMalformed', additionally
    //   the error XML also provides Region of the bucket. To validate
    //   this region is proper we retry the same request with the newly
    //   obtained region.
    const pathStyle = this.pathStyle && !isBrowser;
    let region;
    try {
      const res = await this.makeRequestAsync({
        method,
        bucketName,
        query,
        pathStyle
      }, '', [200], DEFAULT_REGION);
      return extractRegionAsync(res);
    } catch (e) {
      // make alignment with mc cli
      if (e instanceof errors.S3Error) {
        const errCode = e.code;
        const errRegion = e.region;
        if (errCode === 'AccessDenied' && !errRegion) {
          return DEFAULT_REGION;
        }
      }
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore
      if (!(e.name === 'AuthorizationHeaderMalformed')) {
        throw e;
      }
      // @ts-expect-error we set extra properties on error object
      region = e.Region;
      if (!region) {
        throw e;
      }
    }
    const res = await this.makeRequestAsync({
      method,
      bucketName,
      query,
      pathStyle
    }, '', [200], region);
    return await extractRegionAsync(res);
  }

  /**
   * makeRequest is the primitive used by the apis for making S3 requests.
   * payload can be empty string in case of no payload.
   * statusCode is the expected statusCode. If response.statusCode does not match
   * we parse the XML error and call the callback with the error message.
   * A valid region is passed by the calls - listBuckets, makeBucket and
   * getBucketRegion.
   *
   * @deprecated use `makeRequestAsync` instead
   */
  makeRequest(options, payload = '', expectedCodes = [200], region = '', returnResponse, cb) {
    let prom;
    if (returnResponse) {
      prom = this.makeRequestAsync(options, payload, expectedCodes, region);
    } else {
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-expect-error compatible for old behaviour
      prom = this.makeRequestAsyncOmit(options, payload, expectedCodes, region);
    }
    prom.then(result => cb(null, result), err => {
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore
      cb(err);
    });
  }

  /**
   * makeRequestStream will be used directly instead of makeRequest in case the payload
   * is available as a stream. for ex. putObject
   *
   * @deprecated use `makeRequestStreamAsync` instead
   */
  makeRequestStream(options, stream, sha256sum, statusCodes, region, returnResponse, cb) {
    const executor = async () => {
      const res = await this.makeRequestStreamAsync(options, stream, sha256sum, statusCodes, region);
      if (!returnResponse) {
        await drainResponse(res);
      }
      return res;
    };
    executor().then(result => cb(null, result),
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    err => cb(err));
  }

  /**
   * @deprecated use `getBucketRegionAsync` instead
   */
  getBucketRegion(bucketName, cb) {
    return this.getBucketRegionAsync(bucketName).then(result => cb(null, result),
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    err => cb(err));
  }

  // Bucket operations

  /**
   * Creates the bucket `bucketName`.
   *
   */
  async makeBucket(bucketName, region = '', makeOpts) {
    if (!isValidBucketName(bucketName)) {
      throw new errors.InvalidBucketNameError('Invalid bucket name: ' + bucketName);
    }
    // Backward Compatibility
    if (isObject(region)) {
      makeOpts = region;
      region = '';
    }
    if (!isString(region)) {
      throw new TypeError('region should be of type "string"');
    }
    if (makeOpts && !isObject(makeOpts)) {
      throw new TypeError('makeOpts should be of type "object"');
    }
    let payload = '';

    // Region already set in constructor, validate if
    // caller requested bucket location is same.
    if (region && this.region) {
      if (region !== this.region) {
        throw new errors.InvalidArgumentError(`Configured region ${this.region}, requested ${region}`);
      }
    }
    // sending makeBucket request with XML containing 'us-east-1' fails. For
    // default region server expects the request without body
    if (region && region !== DEFAULT_REGION) {
      payload = xml.buildObject({
        CreateBucketConfiguration: {
          $: {
            xmlns: 'http://s3.amazonaws.com/doc/2006-03-01/'
          },
          LocationConstraint: region
        }
      });
    }
    const method = 'PUT';
    const headers = {};
    if (makeOpts && makeOpts.ObjectLocking) {
      headers['x-amz-bucket-object-lock-enabled'] = true;
    }

    // For custom region clients  default to custom region specified in client constructor
    const finalRegion = this.region || region || DEFAULT_REGION;
    const requestOpt = {
      method,
      bucketName,
      headers
    };
    try {
      await this.makeRequestAsyncOmit(requestOpt, payload, [200], finalRegion);
    } catch (err) {
      if (region === '' || region === DEFAULT_REGION) {
        if (err instanceof errors.S3Error) {
          const errCode = err.code;
          const errRegion = err.region;
          if (errCode === 'AuthorizationHeaderMalformed' && errRegion !== '') {
            // Retry with region returned as part of error
            await this.makeRequestAsyncOmit(requestOpt, payload, [200], errCode);
          }
        }
      }
      throw err;
    }
  }

  /**
   * To check if a bucket already exists.
   */
  async bucketExists(bucketName) {
    if (!isValidBucketName(bucketName)) {
      throw new errors.InvalidBucketNameError('Invalid bucket name: ' + bucketName);
    }
    const method = 'HEAD';
    try {
      await this.makeRequestAsyncOmit({
        method,
        bucketName
      });
    } catch (err) {
      // @ts-ignore
      if (err.code === 'NoSuchBucket' || err.code === 'NotFound') {
        return false;
      }
      throw err;
    }
    return true;
  }

  /**
   * @deprecated use promise style API
   */

  async removeBucket(bucketName) {
    if (!isValidBucketName(bucketName)) {
      throw new errors.InvalidBucketNameError('Invalid bucket name: ' + bucketName);
    }
    const method = 'DELETE';
    await this.makeRequestAsyncOmit({
      method,
      bucketName
    }, '', [204]);
    delete this.regionMap[bucketName];
  }

  /**
   * Callback is called with readable stream of the object content.
   */
  async getObject(bucketName, objectName, getOpts) {
    if (!isValidBucketName(bucketName)) {
      throw new errors.InvalidBucketNameError('Invalid bucket name: ' + bucketName);
    }
    if (!isValidObjectName(objectName)) {
      throw new errors.InvalidObjectNameError(`Invalid object name: ${objectName}`);
    }
    return this.getPartialObject(bucketName, objectName, 0, 0, getOpts);
  }

  /**
   * Callback is called with readable stream of the partial object content.
   * @param bucketName
   * @param objectName
   * @param offset
   * @param length - length of the object that will be read in the stream (optional, if not specified we read the rest of the file from the offset)
   * @param getOpts
   */
  async getPartialObject(bucketName, objectName, offset, length = 0, getOpts) {
    if (!isValidBucketName(bucketName)) {
      throw new errors.InvalidBucketNameError('Invalid bucket name: ' + bucketName);
    }
    if (!isValidObjectName(objectName)) {
      throw new errors.InvalidObjectNameError(`Invalid object name: ${objectName}`);
    }
    if (!isNumber(offset)) {
      throw new TypeError('offset should be of type "number"');
    }
    if (!isNumber(length)) {
      throw new TypeError('length should be of type "number"');
    }
    let range = '';
    if (offset || length) {
      if (offset) {
        range = `bytes=${+offset}-`;
      } else {
        range = 'bytes=0-';
        offset = 0;
      }
      if (length) {
        range += `${+length + offset - 1}`;
      }
    }
    let query = '';
    let headers = {
      ...(range !== '' && {
        range
      })
    };
    if (getOpts) {
      const sseHeaders = {
        ...(getOpts.SSECustomerAlgorithm && {
          'X-Amz-Server-Side-Encryption-Customer-Algorithm': getOpts.SSECustomerAlgorithm
        }),
        ...(getOpts.SSECustomerKey && {
          'X-Amz-Server-Side-Encryption-Customer-Key': getOpts.SSECustomerKey
        }),
        ...(getOpts.SSECustomerKeyMD5 && {
          'X-Amz-Server-Side-Encryption-Customer-Key-MD5': getOpts.SSECustomerKeyMD5
        })
      };
      query = qs.stringify(getOpts);
      headers = {
        ...prependXAMZMeta(sseHeaders),
        ...headers
      };
    }
    const expectedStatusCodes = [200];
    if (range) {
      expectedStatusCodes.push(206);
    }
    const method = 'GET';
    return await this.makeRequestAsync({
      method,
      bucketName,
      objectName,
      headers,
      query
    }, '', expectedStatusCodes);
  }

  /**
   * download object content to a file.
   * This method will create a temp file named `${filename}.${base64(etag)}.part.minio` when downloading.
   *
   * @param bucketName - name of the bucket
   * @param objectName - name of the object
   * @param filePath - path to which the object data will be written to
   * @param getOpts - Optional object get option
   */
  async fGetObject(bucketName, objectName, filePath, getOpts) {
    // Input validation.
    if (!isValidBucketName(bucketName)) {
      throw new errors.InvalidBucketNameError('Invalid bucket name: ' + bucketName);
    }
    if (!isValidObjectName(objectName)) {
      throw new errors.InvalidObjectNameError(`Invalid object name: ${objectName}`);
    }
    if (!isString(filePath)) {
      throw new TypeError('filePath should be of type "string"');
    }
    const downloadToTmpFile = async () => {
      let partFileStream;
      const objStat = await this.statObject(bucketName, objectName, getOpts);
      const encodedEtag = Buffer.from(objStat.etag).toString('base64');
      const partFile = `${filePath}.${encodedEtag}.part.minio`;
      await fsp.mkdir(path.dirname(filePath), {
        recursive: true
      });
      let offset = 0;
      try {
        const stats = await fsp.stat(partFile);
        if (objStat.size === stats.size) {
          return partFile;
        }
        offset = stats.size;
        partFileStream = fs.createWriteStream(partFile, {
          flags: 'a'
        });
      } catch (e) {
        if (e instanceof Error && e.code === 'ENOENT') {
          // file not exist
          partFileStream = fs.createWriteStream(partFile, {
            flags: 'w'
          });
        } else {
          // other error, maybe access deny
          throw e;
        }
      }
      const downloadStream = await this.getPartialObject(bucketName, objectName, offset, 0, getOpts);
      await streamPromise.pipeline(downloadStream, partFileStream);
      const stats = await fsp.stat(partFile);
      if (stats.size === objStat.size) {
        return partFile;
      }
      throw new Error('Size mismatch between downloaded file and the object');
    };
    const partFile = await downloadToTmpFile();
    await fsp.rename(partFile, filePath);
  }

  /**
   * Stat information of the object.
   */
  async statObject(bucketName, objectName, statOpts) {
    const statOptDef = statOpts || {};
    if (!isValidBucketName(bucketName)) {
      throw new errors.InvalidBucketNameError('Invalid bucket name: ' + bucketName);
    }
    if (!isValidObjectName(objectName)) {
      throw new errors.InvalidObjectNameError(`Invalid object name: ${objectName}`);
    }
    if (!isObject(statOptDef)) {
      throw new errors.InvalidArgumentError('statOpts should be of type "object"');
    }
    const query = qs.stringify(statOptDef);
    const method = 'HEAD';
    const res = await this.makeRequestAsyncOmit({
      method,
      bucketName,
      objectName,
      query
    });
    return {
      size: parseInt(res.headers['content-length']),
      metaData: extractMetadata(res.headers),
      lastModified: new Date(res.headers['last-modified']),
      versionId: getVersionId(res.headers),
      etag: sanitizeETag(res.headers.etag)
    };
  }
  async removeObject(bucketName, objectName, removeOpts) {
    if (!isValidBucketName(bucketName)) {
      throw new errors.InvalidBucketNameError(`Invalid bucket name: ${bucketName}`);
    }
    if (!isValidObjectName(objectName)) {
      throw new errors.InvalidObjectNameError(`Invalid object name: ${objectName}`);
    }
    if (removeOpts && !isObject(removeOpts)) {
      throw new errors.InvalidArgumentError('removeOpts should be of type "object"');
    }
    const method = 'DELETE';
    const headers = {};
    if (removeOpts !== null && removeOpts !== void 0 && removeOpts.governanceBypass) {
      headers['X-Amz-Bypass-Governance-Retention'] = true;
    }
    if (removeOpts !== null && removeOpts !== void 0 && removeOpts.forceDelete) {
      headers['x-minio-force-delete'] = true;
    }
    const queryParams = {};
    if (removeOpts !== null && removeOpts !== void 0 && removeOpts.versionId) {
      queryParams.versionId = `${removeOpts.versionId}`;
    }
    const query = qs.stringify(queryParams);
    await this.makeRequestAsyncOmit({
      method,
      bucketName,
      objectName,
      headers,
      query
    }, '', [200, 204]);
  }

  // Calls implemented below are related to multipart.

  listIncompleteUploads(bucket, prefix, recursive) {
    if (prefix === undefined) {
      prefix = '';
    }
    if (recursive === undefined) {
      recursive = false;
    }
    if (!isValidBucketName(bucket)) {
      throw new errors.InvalidBucketNameError('Invalid bucket name: ' + bucket);
    }
    if (!isValidPrefix(prefix)) {
      throw new errors.InvalidPrefixError(`Invalid prefix : ${prefix}`);
    }
    if (!isBoolean(recursive)) {
      throw new TypeError('recursive should be of type "boolean"');
    }
    const delimiter = recursive ? '' : '/';
    let keyMarker = '';
    let uploadIdMarker = '';
    const uploads = [];
    let ended = false;

    // TODO: refactor this with async/await and `stream.Readable.from`
    const readStream = new stream.Readable({
      objectMode: true
    });
    readStream._read = () => {
      // push one upload info per _read()
      if (uploads.length) {
        return readStream.push(uploads.shift());
      }
      if (ended) {
        return readStream.push(null);
      }
      this.listIncompleteUploadsQuery(bucket, prefix, keyMarker, uploadIdMarker, delimiter).then(result => {
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        result.prefixes.forEach(prefix => uploads.push(prefix));
        async.eachSeries(result.uploads, (upload, cb) => {
          // for each incomplete upload add the sizes of its uploaded parts
          // eslint-disable-next-line @typescript-eslint/ban-ts-comment
          // @ts-ignore
          this.listParts(bucket, upload.key, upload.uploadId).then(parts => {
            // eslint-disable-next-line @typescript-eslint/ban-ts-comment
            // @ts-ignore
            upload.size = parts.reduce((acc, item) => acc + item.size, 0);
            uploads.push(upload);
            cb();
          }, err => cb(err));
        }, err => {
          if (err) {
            readStream.emit('error', err);
            return;
          }
          if (result.isTruncated) {
            keyMarker = result.nextKeyMarker;
            uploadIdMarker = result.nextUploadIdMarker;
          } else {
            ended = true;
          }

          // eslint-disable-next-line @typescript-eslint/ban-ts-comment
          // @ts-ignore
          readStream._read();
        });
      }, e => {
        readStream.emit('error', e);
      });
    };
    return readStream;
  }

  /**
   * Called by listIncompleteUploads to fetch a batch of incomplete uploads.
   */
  async listIncompleteUploadsQuery(bucketName, prefix, keyMarker, uploadIdMarker, delimiter) {
    if (!isValidBucketName(bucketName)) {
      throw new errors.InvalidBucketNameError('Invalid bucket name: ' + bucketName);
    }
    if (!isString(prefix)) {
      throw new TypeError('prefix should be of type "string"');
    }
    if (!isString(keyMarker)) {
      throw new TypeError('keyMarker should be of type "string"');
    }
    if (!isString(uploadIdMarker)) {
      throw new TypeError('uploadIdMarker should be of type "string"');
    }
    if (!isString(delimiter)) {
      throw new TypeError('delimiter should be of type "string"');
    }
    const queries = [];
    queries.push(`prefix=${uriEscape(prefix)}`);
    queries.push(`delimiter=${uriEscape(delimiter)}`);
    if (keyMarker) {
      queries.push(`key-marker=${uriEscape(keyMarker)}`);
    }
    if (uploadIdMarker) {
      queries.push(`upload-id-marker=${uploadIdMarker}`);
    }
    const maxUploads = 1000;
    queries.push(`max-uploads=${maxUploads}`);
    queries.sort();
    queries.unshift('uploads');
    let query = '';
    if (queries.length > 0) {
      query = `${queries.join('&')}`;
    }
    const method = 'GET';
    const res = await this.makeRequestAsync({
      method,
      bucketName,
      query
    });
    const body = await readAsString(res);
    return xmlParsers.parseListMultipart(body);
  }

  /**
   * Initiate a new multipart upload.
   * @internal
   */
  async initiateNewMultipartUpload(bucketName, objectName, headers) {
    if (!isValidBucketName(bucketName)) {
      throw new errors.InvalidBucketNameError('Invalid bucket name: ' + bucketName);
    }
    if (!isValidObjectName(objectName)) {
      throw new errors.InvalidObjectNameError(`Invalid object name: ${objectName}`);
    }
    if (!isObject(headers)) {
      throw new errors.InvalidObjectNameError('contentType should be of type "object"');
    }
    const method = 'POST';
    const query = 'uploads';
    const res = await this.makeRequestAsync({
      method,
      bucketName,
      objectName,
      query,
      headers
    });
    const body = await readAsBuffer(res);
    return parseInitiateMultipart(body.toString());
  }

  /**
   * Internal Method to abort a multipart upload request in case of any errors.
   *
   * @param bucketName - Bucket Name
   * @param objectName - Object Name
   * @param uploadId - id of a multipart upload to cancel during compose object sequence.
   */
  async abortMultipartUpload(bucketName, objectName, uploadId) {
    const method = 'DELETE';
    const query = `uploadId=${uploadId}`;
    const requestOptions = {
      method,
      bucketName,
      objectName: objectName,
      query
    };
    await this.makeRequestAsyncOmit(requestOptions, '', [204]);
  }
  async findUploadId(bucketName, objectName) {
    var _latestUpload;
    if (!isValidBucketName(bucketName)) {
      throw new errors.InvalidBucketNameError('Invalid bucket name: ' + bucketName);
    }
    if (!isValidObjectName(objectName)) {
      throw new errors.InvalidObjectNameError(`Invalid object name: ${objectName}`);
    }
    let latestUpload;
    let keyMarker = '';
    let uploadIdMarker = '';
    for (;;) {
      const result = await this.listIncompleteUploadsQuery(bucketName, objectName, keyMarker, uploadIdMarker, '');
      for (const upload of result.uploads) {
        if (upload.key === objectName) {
          if (!latestUpload || upload.initiated.getTime() > latestUpload.initiated.getTime()) {
            latestUpload = upload;
          }
        }
      }
      if (result.isTruncated) {
        keyMarker = result.nextKeyMarker;
        uploadIdMarker = result.nextUploadIdMarker;
        continue;
      }
      break;
    }
    return (_latestUpload = latestUpload) === null || _latestUpload === void 0 ? void 0 : _latestUpload.uploadId;
  }

  /**
   * this call will aggregate the parts on the server into a single object.
   */
  async completeMultipartUpload(bucketName, objectName, uploadId, etags) {
    if (!isValidBucketName(bucketName)) {
      throw new errors.InvalidBucketNameError('Invalid bucket name: ' + bucketName);
    }
    if (!isValidObjectName(objectName)) {
      throw new errors.InvalidObjectNameError(`Invalid object name: ${objectName}`);
    }
    if (!isString(uploadId)) {
      throw new TypeError('uploadId should be of type "string"');
    }
    if (!isObject(etags)) {
      throw new TypeError('etags should be of type "Array"');
    }
    if (!uploadId) {
      throw new errors.InvalidArgumentError('uploadId cannot be empty');
    }
    const method = 'POST';
    const query = `uploadId=${uriEscape(uploadId)}`;
    const builder = new xml2js.Builder();
    const payload = builder.buildObject({
      CompleteMultipartUpload: {
        $: {
          xmlns: 'http://s3.amazonaws.com/doc/2006-03-01/'
        },
        Part: etags.map(etag => {
          return {
            PartNumber: etag.part,
            ETag: etag.etag
          };
        })
      }
    });
    const res = await this.makeRequestAsync({
      method,
      bucketName,
      objectName,
      query
    }, payload);
    const body = await readAsBuffer(res);
    const result = parseCompleteMultipart(body.toString());
    if (!result) {
      throw new Error('BUG: failed to parse server response');
    }
    if (result.errCode) {
      // Multipart Complete API returns an error XML after a 200 http status
      throw new errors.S3Error(result.errMessage);
    }
    return {
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore
      etag: result.etag,
      versionId: getVersionId(res.headers)
    };
  }

  /**
   * Get part-info of all parts of an incomplete upload specified by uploadId.
   */
  async listParts(bucketName, objectName, uploadId) {
    if (!isValidBucketName(bucketName)) {
      throw new errors.InvalidBucketNameError('Invalid bucket name: ' + bucketName);
    }
    if (!isValidObjectName(objectName)) {
      throw new errors.InvalidObjectNameError(`Invalid object name: ${objectName}`);
    }
    if (!isString(uploadId)) {
      throw new TypeError('uploadId should be of type "string"');
    }
    if (!uploadId) {
      throw new errors.InvalidArgumentError('uploadId cannot be empty');
    }
    const parts = [];
    let marker = 0;
    let result;
    do {
      result = await this.listPartsQuery(bucketName, objectName, uploadId, marker);
      marker = result.marker;
      parts.push(...result.parts);
    } while (result.isTruncated);
    return parts;
  }

  /**
   * Called by listParts to fetch a batch of part-info
   */
  async listPartsQuery(bucketName, objectName, uploadId, marker) {
    if (!isValidBucketName(bucketName)) {
      throw new errors.InvalidBucketNameError('Invalid bucket name: ' + bucketName);
    }
    if (!isValidObjectName(objectName)) {
      throw new errors.InvalidObjectNameError(`Invalid object name: ${objectName}`);
    }
    if (!isString(uploadId)) {
      throw new TypeError('uploadId should be of type "string"');
    }
    if (!isNumber(marker)) {
      throw new TypeError('marker should be of type "number"');
    }
    if (!uploadId) {
      throw new errors.InvalidArgumentError('uploadId cannot be empty');
    }
    let query = `uploadId=${uriEscape(uploadId)}`;
    if (marker) {
      query += `&part-number-marker=${marker}`;
    }
    const method = 'GET';
    const res = await this.makeRequestAsync({
      method,
      bucketName,
      objectName,
      query
    });
    return xmlParsers.parseListParts(await readAsString(res));
  }
  async listBuckets() {
    const method = 'GET';
    const regionConf = this.region || DEFAULT_REGION;
    const httpRes = await this.makeRequestAsync({
      method
    }, '', [200], regionConf);
    const xmlResult = await readAsString(httpRes);
    return xmlParsers.parseListBucket(xmlResult);
  }

  /**
   * Calculate part size given the object size. Part size will be atleast this.partSize
   */
  calculatePartSize(size) {
    if (!isNumber(size)) {
      throw new TypeError('size should be of type "number"');
    }
    if (size > this.maxObjectSize) {
      throw new TypeError(`size should not be more than ${this.maxObjectSize}`);
    }
    if (this.overRidePartSize) {
      return this.partSize;
    }
    let partSize = this.partSize;
    for (;;) {
      // while(true) {...} throws linting error.
      // If partSize is big enough to accomodate the object size, then use it.
      if (partSize * 10000 > size) {
        return partSize;
      }
      // Try part sizes as 64MB, 80MB, 96MB etc.
      partSize += 16 * 1024 * 1024;
    }
  }

  /**
   * Uploads the object using contents from a file
   */
  async fPutObject(bucketName, objectName, filePath, metaData) {
    if (!isValidBucketName(bucketName)) {
      throw new errors.InvalidBucketNameError('Invalid bucket name: ' + bucketName);
    }
    if (!isValidObjectName(objectName)) {
      throw new errors.InvalidObjectNameError(`Invalid object name: ${objectName}`);
    }
    if (!isString(filePath)) {
      throw new TypeError('filePath should be of type "string"');
    }
    if (metaData && !isObject(metaData)) {
      throw new TypeError('metaData should be of type "object"');
    }

    // Inserts correct `content-type` attribute based on metaData and filePath
    metaData = insertContentType(metaData || {}, filePath);
    const stat = await fsp.stat(filePath);
    return await this.putObject(bucketName, objectName, fs.createReadStream(filePath), stat.size, metaData);
  }

  /**
   *  Uploading a stream, "Buffer" or "string".
   *  It's recommended to pass `size` argument with stream.
   */
  async putObject(bucketName, objectName, stream, size, metaData) {
    if (!isValidBucketName(bucketName)) {
      throw new errors.InvalidBucketNameError(`Invalid bucket name: ${bucketName}`);
    }
    if (!isValidObjectName(objectName)) {
      throw new errors.InvalidObjectNameError(`Invalid object name: ${objectName}`);
    }

    // We'll need to shift arguments to the left because of metaData
    // and size being optional.
    if (isObject(size)) {
      metaData = size;
    }
    // Ensures Metadata has appropriate prefix for A3 API
    const headers = prependXAMZMeta(metaData);
    if (typeof stream === 'string' || stream instanceof Buffer) {
      // Adapts the non-stream interface into a stream.
      size = stream.length;
      stream = readableStream(stream);
    } else if (!isReadableStream(stream)) {
      throw new TypeError('third argument should be of type "stream.Readable" or "Buffer" or "string"');
    }
    if (isNumber(size) && size < 0) {
      throw new errors.InvalidArgumentError(`size cannot be negative, given size: ${size}`);
    }

    // Get the part size and forward that to the BlockStream. Default to the
    // largest block size possible if necessary.
    if (!isNumber(size)) {
      size = this.maxObjectSize;
    }

    // Get the part size and forward that to the BlockStream. Default to the
    // largest block size possible if necessary.
    if (size === undefined) {
      const statSize = await getContentLength(stream);
      if (statSize !== null) {
        size = statSize;
      }
    }
    if (!isNumber(size)) {
      // Backward compatibility
      size = this.maxObjectSize;
    }
    if (size === 0) {
      return this.uploadBuffer(bucketName, objectName, headers, Buffer.from(''));
    }
    const partSize = this.calculatePartSize(size);
    if (typeof stream === 'string' || Buffer.isBuffer(stream) || size <= partSize) {
      const buf = isReadableStream(stream) ? await readAsBuffer(stream) : Buffer.from(stream);
      return this.uploadBuffer(bucketName, objectName, headers, buf);
    }
    return this.uploadStream(bucketName, objectName, headers, stream, partSize);
  }

  /**
   * method to upload buffer in one call
   * @private
   */
  async uploadBuffer(bucketName, objectName, headers, buf) {
    const {
      md5sum,
      sha256sum
    } = hashBinary(buf, this.enableSHA256);
    headers['Content-Length'] = buf.length;
    if (!this.enableSHA256) {
      headers['Content-MD5'] = md5sum;
    }
    const res = await this.makeRequestStreamAsync({
      method: 'PUT',
      bucketName,
      objectName,
      headers
    }, buf, sha256sum, [200], '');
    await drainResponse(res);
    return {
      etag: sanitizeETag(res.headers.etag),
      versionId: getVersionId(res.headers)
    };
  }

  /**
   * upload stream with MultipartUpload
   * @private
   */
  async uploadStream(bucketName, objectName, headers, body, partSize) {
    // A map of the previously uploaded chunks, for resuming a file upload. This
    // will be null if we aren't resuming an upload.
    const oldParts = {};

    // Keep track of the etags for aggregating the chunks together later. Each
    // etag represents a single chunk of the file.
    const eTags = [];
    const previousUploadId = await this.findUploadId(bucketName, objectName);
    let uploadId;
    if (!previousUploadId) {
      uploadId = await this.initiateNewMultipartUpload(bucketName, objectName, headers);
    } else {
      uploadId = previousUploadId;
      const oldTags = await this.listParts(bucketName, objectName, previousUploadId);
      oldTags.forEach(e => {
        oldParts[e.part] = e;
      });
    }
    const chunkier = new BlockStream2({
      size: partSize,
      zeroPadding: false
    });

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const [_, o] = await Promise.all([new Promise((resolve, reject) => {
      body.pipe(chunkier).on('error', reject);
      chunkier.on('end', resolve).on('error', reject);
    }), (async () => {
      let partNumber = 1;
      for await (const chunk of chunkier) {
        const md5 = crypto.createHash('md5').update(chunk).digest();
        const oldPart = oldParts[partNumber];
        if (oldPart) {
          if (oldPart.etag === md5.toString('hex')) {
            eTags.push({
              part: partNumber,
              etag: oldPart.etag
            });
            partNumber++;
            continue;
          }
        }
        partNumber++;

        // now start to upload missing part
        const options = {
          method: 'PUT',
          query: qs.stringify({
            partNumber,
            uploadId
          }),
          headers: {
            'Content-Length': chunk.length,
            'Content-MD5': md5.toString('base64')
          },
          bucketName,
          objectName
        };
        const response = await this.makeRequestAsyncOmit(options, chunk);
        let etag = response.headers.etag;
        if (etag) {
          etag = etag.replace(/^"/, '').replace(/"$/, '');
        } else {
          etag = '';
        }
        eTags.push({
          part: partNumber,
          etag
        });
      }
      return await this.completeMultipartUpload(bucketName, objectName, uploadId, eTags);
    })()]);
    return o;
  }
  async removeBucketReplication(bucketName) {
    if (!isValidBucketName(bucketName)) {
      throw new errors.InvalidBucketNameError('Invalid bucket name: ' + bucketName);
    }
    const method = 'DELETE';
    const query = 'replication';
    await this.makeRequestAsyncOmit({
      method,
      bucketName,
      query
    }, '', [200, 204], '');
  }
  async setBucketReplication(bucketName, replicationConfig) {
    if (!isValidBucketName(bucketName)) {
      throw new errors.InvalidBucketNameError('Invalid bucket name: ' + bucketName);
    }
    if (!isObject(replicationConfig)) {
      throw new errors.InvalidArgumentError('replicationConfig should be of type "object"');
    } else {
      if (_.isEmpty(replicationConfig.role)) {
        throw new errors.InvalidArgumentError('Role cannot be empty');
      } else if (replicationConfig.role && !isString(replicationConfig.role)) {
        throw new errors.InvalidArgumentError('Invalid value for role', replicationConfig.role);
      }
      if (_.isEmpty(replicationConfig.rules)) {
        throw new errors.InvalidArgumentError('Minimum one replication rule must be specified');
      }
    }
    const method = 'PUT';
    const query = 'replication';
    const headers = {};
    const replicationParamsConfig = {
      ReplicationConfiguration: {
        Role: replicationConfig.role,
        Rule: replicationConfig.rules
      }
    };
    const builder = new xml2js.Builder({
      renderOpts: {
        pretty: false
      },
      headless: true
    });
    const payload = builder.buildObject(replicationParamsConfig);
    headers['Content-MD5'] = toMd5(payload);
    await this.makeRequestAsyncOmit({
      method,
      bucketName,
      query,
      headers
    }, payload);
  }
  async getBucketReplication(bucketName) {
    if (!isValidBucketName(bucketName)) {
      throw new errors.InvalidBucketNameError('Invalid bucket name: ' + bucketName);
    }
    const method = 'GET';
    const query = 'replication';
    const httpRes = await this.makeRequestAsync({
      method,
      bucketName,
      query
    }, '', [200, 204]);
    const xmlResult = await readAsString(httpRes);
    return xmlParsers.parseReplicationConfig(xmlResult);
  }
  async getObjectLegalHold(bucketName, objectName, getOpts) {
    if (!isValidBucketName(bucketName)) {
      throw new errors.InvalidBucketNameError('Invalid bucket name: ' + bucketName);
    }
    if (!isValidObjectName(objectName)) {
      throw new errors.InvalidObjectNameError(`Invalid object name: ${objectName}`);
    }
    if (getOpts) {
      if (!isObject(getOpts)) {
        throw new TypeError('getOpts should be of type "Object"');
      } else if (Object.keys(getOpts).length > 0 && getOpts.versionId && !isString(getOpts.versionId)) {
        throw new TypeError('versionId should be of type string.:', getOpts.versionId);
      }
    }
    const method = 'GET';
    let query = 'legal-hold';
    if (getOpts !== null && getOpts !== void 0 && getOpts.versionId) {
      query += `&versionId=${getOpts.versionId}`;
    }
    const httpRes = await this.makeRequestAsync({
      method,
      bucketName,
      objectName,
      query
    }, '', [200]);
    const strRes = await readAsString(httpRes);
    return parseObjectLegalHoldConfig(strRes);
  }
  async setObjectLegalHold(bucketName, objectName, setOpts = {
    status: LEGAL_HOLD_STATUS.ENABLED
  }) {
    if (!isValidBucketName(bucketName)) {
      throw new errors.InvalidBucketNameError('Invalid bucket name: ' + bucketName);
    }
    if (!isValidObjectName(objectName)) {
      throw new errors.InvalidObjectNameError(`Invalid object name: ${objectName}`);
    }
    if (!isObject(setOpts)) {
      throw new TypeError('setOpts should be of type "Object"');
    } else {
      if (![LEGAL_HOLD_STATUS.ENABLED, LEGAL_HOLD_STATUS.DISABLED].includes(setOpts === null || setOpts === void 0 ? void 0 : setOpts.status)) {
        throw new TypeError('Invalid status: ' + setOpts.status);
      }
      if (setOpts.versionId && !setOpts.versionId.length) {
        throw new TypeError('versionId should be of type string.:' + setOpts.versionId);
      }
    }
    const method = 'PUT';
    let query = 'legal-hold';
    if (setOpts.versionId) {
      query += `&versionId=${setOpts.versionId}`;
    }
    const config = {
      Status: setOpts.status
    };
    const builder = new xml2js.Builder({
      rootName: 'LegalHold',
      renderOpts: {
        pretty: false
      },
      headless: true
    });
    const payload = builder.buildObject(config);
    const headers = {};
    headers['Content-MD5'] = toMd5(payload);
    await this.makeRequestAsyncOmit({
      method,
      bucketName,
      objectName,
      query,
      headers
    }, payload);
  }

  /**
   * Get Tags associated with a Bucket
   */
  async getBucketTagging(bucketName) {
    if (!isValidBucketName(bucketName)) {
      throw new errors.InvalidBucketNameError(`Invalid bucket name: ${bucketName}`);
    }
    const method = 'GET';
    const query = 'tagging';
    const requestOptions = {
      method,
      bucketName,
      query
    };
    const response = await this.makeRequestAsync(requestOptions);
    const body = await readAsString(response);
    return xmlParsers.parseTagging(body);
  }

  /**
   *  Get the tags associated with a bucket OR an object
   */
  async getObjectTagging(bucketName, objectName, getOpts) {
    const method = 'GET';
    let query = 'tagging';
    if (!isValidBucketName(bucketName)) {
      throw new errors.InvalidBucketNameError('Invalid bucket name: ' + bucketName);
    }
    if (!isValidObjectName(objectName)) {
      throw new errors.InvalidBucketNameError('Invalid object name: ' + objectName);
    }
    if (getOpts && !isObject(getOpts)) {
      throw new errors.InvalidArgumentError('getOpts should be of type "object"');
    }
    if (getOpts && getOpts.versionId) {
      query = `${query}&versionId=${getOpts.versionId}`;
    }
    const requestOptions = {
      method,
      bucketName,
      query
    };
    if (objectName) {
      requestOptions['objectName'] = objectName;
    }
    const response = await this.makeRequestAsync(requestOptions);
    const body = await readAsString(response);
    return xmlParsers.parseTagging(body);
  }

  /**
   *  Set the policy on a bucket or an object prefix.
   */
  async setBucketPolicy(bucketName, policy) {
    // Validate arguments.
    if (!isValidBucketName(bucketName)) {
      throw new errors.InvalidBucketNameError(`Invalid bucket name: ${bucketName}`);
    }
    if (!isString(policy)) {
      throw new errors.InvalidBucketPolicyError(`Invalid bucket policy: ${policy} - must be "string"`);
    }
    const query = 'policy';
    let method = 'DELETE';
    if (policy) {
      method = 'PUT';
    }
    await this.makeRequestAsyncOmit({
      method,
      bucketName,
      query
    }, policy, [204], '');
  }

  /**
   * Get the policy on a bucket or an object prefix.
   */
  async getBucketPolicy(bucketName) {
    // Validate arguments.
    if (!isValidBucketName(bucketName)) {
      throw new errors.InvalidBucketNameError(`Invalid bucket name: ${bucketName}`);
    }
    const method = 'GET';
    const query = 'policy';
    const res = await this.makeRequestAsync({
      method,
      bucketName,
      query
    });
    return await readAsString(res);
  }
  async putObjectRetention(bucketName, objectName, retentionOpts = {}) {
    if (!isValidBucketName(bucketName)) {
      throw new errors.InvalidBucketNameError(`Invalid bucket name: ${bucketName}`);
    }
    if (!isValidObjectName(objectName)) {
      throw new errors.InvalidObjectNameError(`Invalid object name: ${objectName}`);
    }
    if (!isObject(retentionOpts)) {
      throw new errors.InvalidArgumentError('retentionOpts should be of type "object"');
    } else {
      if (retentionOpts.governanceBypass && !isBoolean(retentionOpts.governanceBypass)) {
        throw new errors.InvalidArgumentError(`Invalid value for governanceBypass: ${retentionOpts.governanceBypass}`);
      }
      if (retentionOpts.mode && ![RETENTION_MODES.COMPLIANCE, RETENTION_MODES.GOVERNANCE].includes(retentionOpts.mode)) {
        throw new errors.InvalidArgumentError(`Invalid object retention mode: ${retentionOpts.mode}`);
      }
      if (retentionOpts.retainUntilDate && !isString(retentionOpts.retainUntilDate)) {
        throw new errors.InvalidArgumentError(`Invalid value for retainUntilDate: ${retentionOpts.retainUntilDate}`);
      }
      if (retentionOpts.versionId && !isString(retentionOpts.versionId)) {
        throw new errors.InvalidArgumentError(`Invalid value for versionId: ${retentionOpts.versionId}`);
      }
    }
    const method = 'PUT';
    let query = 'retention';
    const headers = {};
    if (retentionOpts.governanceBypass) {
      headers['X-Amz-Bypass-Governance-Retention'] = true;
    }
    const builder = new xml2js.Builder({
      rootName: 'Retention',
      renderOpts: {
        pretty: false
      },
      headless: true
    });
    const params = {};
    if (retentionOpts.mode) {
      params.Mode = retentionOpts.mode;
    }
    if (retentionOpts.retainUntilDate) {
      params.RetainUntilDate = retentionOpts.retainUntilDate;
    }
    if (retentionOpts.versionId) {
      query += `&versionId=${retentionOpts.versionId}`;
    }
    const payload = builder.buildObject(params);
    headers['Content-MD5'] = toMd5(payload);
    await this.makeRequestAsyncOmit({
      method,
      bucketName,
      objectName,
      query,
      headers
    }, payload, [200, 204]);
  }
  async getObjectLockConfig(bucketName) {
    if (!isValidBucketName(bucketName)) {
      throw new errors.InvalidBucketNameError('Invalid bucket name: ' + bucketName);
    }
    const method = 'GET';
    const query = 'object-lock';
    const httpRes = await this.makeRequestAsync({
      method,
      bucketName,
      query
    });
    const xmlResult = await readAsString(httpRes);
    return xmlParsers.parseObjectLockConfig(xmlResult);
  }
  async setObjectLockConfig(bucketName, lockConfigOpts) {
    const retentionModes = [RETENTION_MODES.COMPLIANCE, RETENTION_MODES.GOVERNANCE];
    const validUnits = [RETENTION_VALIDITY_UNITS.DAYS, RETENTION_VALIDITY_UNITS.YEARS];
    if (!isValidBucketName(bucketName)) {
      throw new errors.InvalidBucketNameError('Invalid bucket name: ' + bucketName);
    }
    if (lockConfigOpts.mode && !retentionModes.includes(lockConfigOpts.mode)) {
      throw new TypeError(`lockConfigOpts.mode should be one of ${retentionModes}`);
    }
    if (lockConfigOpts.unit && !validUnits.includes(lockConfigOpts.unit)) {
      throw new TypeError(`lockConfigOpts.unit should be one of ${validUnits}`);
    }
    if (lockConfigOpts.validity && !isNumber(lockConfigOpts.validity)) {
      throw new TypeError(`lockConfigOpts.validity should be a number`);
    }
    const method = 'PUT';
    const query = 'object-lock';
    const config = {
      ObjectLockEnabled: 'Enabled'
    };
    const configKeys = Object.keys(lockConfigOpts);
    const isAllKeysSet = ['unit', 'mode', 'validity'].every(lck => configKeys.includes(lck));
    // Check if keys are present and all keys are present.
    if (configKeys.length > 0) {
      if (!isAllKeysSet) {
        throw new TypeError(`lockConfigOpts.mode,lockConfigOpts.unit,lockConfigOpts.validity all the properties should be specified.`);
      } else {
        config.Rule = {
          DefaultRetention: {}
        };
        if (lockConfigOpts.mode) {
          config.Rule.DefaultRetention.Mode = lockConfigOpts.mode;
        }
        if (lockConfigOpts.unit === RETENTION_VALIDITY_UNITS.DAYS) {
          config.Rule.DefaultRetention.Days = lockConfigOpts.validity;
        } else if (lockConfigOpts.unit === RETENTION_VALIDITY_UNITS.YEARS) {
          config.Rule.DefaultRetention.Years = lockConfigOpts.validity;
        }
      }
    }
    const builder = new xml2js.Builder({
      rootName: 'ObjectLockConfiguration',
      renderOpts: {
        pretty: false
      },
      headless: true
    });
    const payload = builder.buildObject(config);
    const headers = {};
    headers['Content-MD5'] = toMd5(payload);
    await this.makeRequestAsyncOmit({
      method,
      bucketName,
      query,
      headers
    }, payload);
  }
  async getBucketVersioning(bucketName) {
    if (!isValidBucketName(bucketName)) {
      throw new errors.InvalidBucketNameError('Invalid bucket name: ' + bucketName);
    }
    const method = 'GET';
    const query = 'versioning';
    const httpRes = await this.makeRequestAsync({
      method,
      bucketName,
      query
    });
    const xmlResult = await readAsString(httpRes);
    return await xmlParsers.parseBucketVersioningConfig(xmlResult);
  }
  async setBucketVersioning(bucketName, versionConfig) {
    if (!isValidBucketName(bucketName)) {
      throw new errors.InvalidBucketNameError('Invalid bucket name: ' + bucketName);
    }
    if (!Object.keys(versionConfig).length) {
      throw new errors.InvalidArgumentError('versionConfig should be of type "object"');
    }
    const method = 'PUT';
    const query = 'versioning';
    const builder = new xml2js.Builder({
      rootName: 'VersioningConfiguration',
      renderOpts: {
        pretty: false
      },
      headless: true
    });
    const payload = builder.buildObject(versionConfig);
    await this.makeRequestAsyncOmit({
      method,
      bucketName,
      query
    }, payload);
  }
  async setTagging(taggingParams) {
    const {
      bucketName,
      objectName,
      tags,
      putOpts
    } = taggingParams;
    const method = 'PUT';
    let query = 'tagging';
    if (putOpts && putOpts !== null && putOpts !== void 0 && putOpts.versionId) {
      query = `${query}&versionId=${putOpts.versionId}`;
    }
    const tagsList = [];
    for (const [key, value] of Object.entries(tags)) {
      tagsList.push({
        Key: key,
        Value: value
      });
    }
    const taggingConfig = {
      Tagging: {
        TagSet: {
          Tag: tagsList
        }
      }
    };
    const headers = {};
    const builder = new xml2js.Builder({
      headless: true,
      renderOpts: {
        pretty: false
      }
    });
    const payloadBuf = Buffer.from(builder.buildObject(taggingConfig));
    const requestOptions = {
      method,
      bucketName,
      query,
      headers,
      ...(objectName && {
        objectName: objectName
      })
    };
    headers['Content-MD5'] = toMd5(payloadBuf);
    await this.makeRequestAsyncOmit(requestOptions, payloadBuf);
  }
  async removeTagging({
    bucketName,
    objectName,
    removeOpts
  }) {
    const method = 'DELETE';
    let query = 'tagging';
    if (removeOpts && Object.keys(removeOpts).length && removeOpts.versionId) {
      query = `${query}&versionId=${removeOpts.versionId}`;
    }
    const requestOptions = {
      method,
      bucketName,
      objectName,
      query
    };
    if (objectName) {
      requestOptions['objectName'] = objectName;
    }
    await this.makeRequestAsync(requestOptions, '', [200, 204]);
  }
  async setBucketTagging(bucketName, tags) {
    if (!isValidBucketName(bucketName)) {
      throw new errors.InvalidBucketNameError('Invalid bucket name: ' + bucketName);
    }
    if (!isPlainObject(tags)) {
      throw new errors.InvalidArgumentError('tags should be of type "object"');
    }
    if (Object.keys(tags).length > 10) {
      throw new errors.InvalidArgumentError('maximum tags allowed is 10"');
    }
    await this.setTagging({
      bucketName,
      tags
    });
  }
  async removeBucketTagging(bucketName) {
    if (!isValidBucketName(bucketName)) {
      throw new errors.InvalidBucketNameError('Invalid bucket name: ' + bucketName);
    }
    await this.removeTagging({
      bucketName
    });
  }
  async setObjectTagging(bucketName, objectName, tags, putOpts) {
    if (!isValidBucketName(bucketName)) {
      throw new errors.InvalidBucketNameError('Invalid bucket name: ' + bucketName);
    }
    if (!isValidObjectName(objectName)) {
      throw new errors.InvalidBucketNameError('Invalid object name: ' + objectName);
    }
    if (!isPlainObject(tags)) {
      throw new errors.InvalidArgumentError('tags should be of type "object"');
    }
    if (Object.keys(tags).length > 10) {
      throw new errors.InvalidArgumentError('Maximum tags allowed is 10"');
    }
    await this.setTagging({
      bucketName,
      objectName,
      tags,
      putOpts
    });
  }
  async removeObjectTagging(bucketName, objectName, removeOpts) {
    if (!isValidBucketName(bucketName)) {
      throw new errors.InvalidBucketNameError('Invalid bucket name: ' + bucketName);
    }
    if (!isValidObjectName(objectName)) {
      throw new errors.InvalidBucketNameError('Invalid object name: ' + objectName);
    }
    if (removeOpts && Object.keys(removeOpts).length && !isObject(removeOpts)) {
      throw new errors.InvalidArgumentError('removeOpts should be of type "object"');
    }
    await this.removeTagging({
      bucketName,
      objectName,
      removeOpts
    });
  }
  async selectObjectContent(bucketName, objectName, selectOpts) {
    if (!isValidBucketName(bucketName)) {
      throw new errors.InvalidBucketNameError(`Invalid bucket name: ${bucketName}`);
    }
    if (!isValidObjectName(objectName)) {
      throw new errors.InvalidObjectNameError(`Invalid object name: ${objectName}`);
    }
    if (!_.isEmpty(selectOpts)) {
      if (!isString(selectOpts.expression)) {
        throw new TypeError('sqlExpression should be of type "string"');
      }
      if (!_.isEmpty(selectOpts.inputSerialization)) {
        if (!isObject(selectOpts.inputSerialization)) {
          throw new TypeError('inputSerialization should be of type "object"');
        }
      } else {
        throw new TypeError('inputSerialization is required');
      }
      if (!_.isEmpty(selectOpts.outputSerialization)) {
        if (!isObject(selectOpts.outputSerialization)) {
          throw new TypeError('outputSerialization should be of type "object"');
        }
      } else {
        throw new TypeError('outputSerialization is required');
      }
    } else {
      throw new TypeError('valid select configuration is required');
    }
    const method = 'POST';
    const query = `select&select-type=2`;
    const config = [{
      Expression: selectOpts.expression
    }, {
      ExpressionType: selectOpts.expressionType || 'SQL'
    }, {
      InputSerialization: [selectOpts.inputSerialization]
    }, {
      OutputSerialization: [selectOpts.outputSerialization]
    }];

    // Optional
    if (selectOpts.requestProgress) {
      config.push({
        RequestProgress: selectOpts === null || selectOpts === void 0 ? void 0 : selectOpts.requestProgress
      });
    }
    // Optional
    if (selectOpts.scanRange) {
      config.push({
        ScanRange: selectOpts.scanRange
      });
    }
    const builder = new xml2js.Builder({
      rootName: 'SelectObjectContentRequest',
      renderOpts: {
        pretty: false
      },
      headless: true
    });
    const payload = builder.buildObject(config);
    const res = await this.makeRequestAsync({
      method,
      bucketName,
      objectName,
      query
    }, payload);
    const body = await readAsBuffer(res);
    return parseSelectObjectContentResponse(body);
  }
  async applyBucketLifecycle(bucketName, policyConfig) {
    const method = 'PUT';
    const query = 'lifecycle';
    const headers = {};
    const builder = new xml2js.Builder({
      rootName: 'LifecycleConfiguration',
      headless: true,
      renderOpts: {
        pretty: false
      }
    });
    const payload = builder.buildObject(policyConfig);
    headers['Content-MD5'] = toMd5(payload);
    await this.makeRequestAsyncOmit({
      method,
      bucketName,
      query,
      headers
    }, payload);
  }
  async removeBucketLifecycle(bucketName) {
    if (!isValidBucketName(bucketName)) {
      throw new errors.InvalidBucketNameError('Invalid bucket name: ' + bucketName);
    }
    const method = 'DELETE';
    const query = 'lifecycle';
    await this.makeRequestAsyncOmit({
      method,
      bucketName,
      query
    }, '', [204]);
  }
  async setBucketLifecycle(bucketName, lifeCycleConfig) {
    if (!isValidBucketName(bucketName)) {
      throw new errors.InvalidBucketNameError('Invalid bucket name: ' + bucketName);
    }
    if (_.isEmpty(lifeCycleConfig)) {
      await this.removeBucketLifecycle(bucketName);
    } else {
      await this.applyBucketLifecycle(bucketName, lifeCycleConfig);
    }
  }
  async getBucketLifecycle(bucketName) {
    if (!isValidBucketName(bucketName)) {
      throw new errors.InvalidBucketNameError('Invalid bucket name: ' + bucketName);
    }
    const method = 'GET';
    const query = 'lifecycle';
    const res = await this.makeRequestAsync({
      method,
      bucketName,
      query
    });
    const body = await readAsString(res);
    return xmlParsers.parseLifecycleConfig(body);
  }
  async setBucketEncryption(bucketName, encryptionConfig) {
    if (!isValidBucketName(bucketName)) {
      throw new errors.InvalidBucketNameError('Invalid bucket name: ' + bucketName);
    }
    if (!_.isEmpty(encryptionConfig) && encryptionConfig.Rule.length > 1) {
      throw new errors.InvalidArgumentError('Invalid Rule length. Only one rule is allowed.: ' + encryptionConfig.Rule);
    }
    let encryptionObj = encryptionConfig;
    if (_.isEmpty(encryptionConfig)) {
      encryptionObj = {
        // Default MinIO Server Supported Rule
        Rule: [{
          ApplyServerSideEncryptionByDefault: {
            SSEAlgorithm: 'AES256'
          }
        }]
      };
    }
    const method = 'PUT';
    const query = 'encryption';
    const builder = new xml2js.Builder({
      rootName: 'ServerSideEncryptionConfiguration',
      renderOpts: {
        pretty: false
      },
      headless: true
    });
    const payload = builder.buildObject(encryptionObj);
    const headers = {};
    headers['Content-MD5'] = toMd5(payload);
    await this.makeRequestAsyncOmit({
      method,
      bucketName,
      query,
      headers
    }, payload);
  }
  async getBucketEncryption(bucketName) {
    if (!isValidBucketName(bucketName)) {
      throw new errors.InvalidBucketNameError('Invalid bucket name: ' + bucketName);
    }
    const method = 'GET';
    const query = 'encryption';
    const res = await this.makeRequestAsync({
      method,
      bucketName,
      query
    });
    const body = await readAsString(res);
    return xmlParsers.parseBucketEncryptionConfig(body);
  }
  async removeBucketEncryption(bucketName) {
    if (!isValidBucketName(bucketName)) {
      throw new errors.InvalidBucketNameError('Invalid bucket name: ' + bucketName);
    }
    const method = 'DELETE';
    const query = 'encryption';
    await this.makeRequestAsyncOmit({
      method,
      bucketName,
      query
    }, '', [204]);
  }
  async getObjectRetention(bucketName, objectName, getOpts) {
    if (!isValidBucketName(bucketName)) {
      throw new errors.InvalidBucketNameError('Invalid bucket name: ' + bucketName);
    }
    if (!isValidObjectName(objectName)) {
      throw new errors.InvalidObjectNameError(`Invalid object name: ${objectName}`);
    }
    if (getOpts && !isObject(getOpts)) {
      throw new errors.InvalidArgumentError('getOpts should be of type "object"');
    } else if (getOpts !== null && getOpts !== void 0 && getOpts.versionId && !isString(getOpts.versionId)) {
      throw new errors.InvalidArgumentError('versionId should be of type "string"');
    }
    const method = 'GET';
    let query = 'retention';
    if (getOpts !== null && getOpts !== void 0 && getOpts.versionId) {
      query += `&versionId=${getOpts.versionId}`;
    }
    const res = await this.makeRequestAsync({
      method,
      bucketName,
      objectName,
      query
    });
    const body = await readAsString(res);
    return xmlParsers.parseObjectRetentionConfig(body);
  }
  async removeObjects(bucketName, objectsList) {
    if (!isValidBucketName(bucketName)) {
      throw new errors.InvalidBucketNameError('Invalid bucket name: ' + bucketName);
    }
    if (!Array.isArray(objectsList)) {
      throw new errors.InvalidArgumentError('objectsList should be a list');
    }
    const runDeleteObjects = async batch => {
      const delObjects = batch.map(value => {
        return isObject(value) ? {
          Key: value.name,
          VersionId: value.versionId
        } : {
          Key: value
        };
      });
      const remObjects = {
        Delete: {
          Quiet: true,
          Object: delObjects
        }
      };
      const payload = Buffer.from(new xml2js.Builder({
        headless: true
      }).buildObject(remObjects));
      const headers = {
        'Content-MD5': toMd5(payload)
      };
      const res = await this.makeRequestAsync({
        method: 'POST',
        bucketName,
        query: 'delete',
        headers
      }, payload);
      const body = await readAsString(res);
      return xmlParsers.removeObjectsParser(body);
    };
    const maxEntries = 1000; // max entries accepted in server for DeleteMultipleObjects API.
    // Client side batching
    const batches = [];
    for (let i = 0; i < objectsList.length; i += maxEntries) {
      batches.push(objectsList.slice(i, i + maxEntries));
    }
    const batchResults = await Promise.all(batches.map(runDeleteObjects));
    return batchResults.flat();
  }
  async removeIncompleteUpload(bucketName, objectName) {
    if (!isValidBucketName(bucketName)) {
      throw new errors.IsValidBucketNameError('Invalid bucket name: ' + bucketName);
    }
    if (!isValidObjectName(objectName)) {
      throw new errors.InvalidObjectNameError(`Invalid object name: ${objectName}`);
    }
    const removeUploadId = await this.findUploadId(bucketName, objectName);
    const method = 'DELETE';
    const query = `uploadId=${removeUploadId}`;
    await this.makeRequestAsyncOmit({
      method,
      bucketName,
      objectName,
      query
    }, '', [204]);
  }
  async copyObjectV1(targetBucketName, targetObjectName, sourceBucketNameAndObjectName, conditions) {
    if (typeof conditions == 'function') {
      conditions = null;
    }
    if (!isValidBucketName(targetBucketName)) {
      throw new errors.InvalidBucketNameError('Invalid bucket name: ' + targetBucketName);
    }
    if (!isValidObjectName(targetObjectName)) {
      throw new errors.InvalidObjectNameError(`Invalid object name: ${targetObjectName}`);
    }
    if (!isString(sourceBucketNameAndObjectName)) {
      throw new TypeError('sourceBucketNameAndObjectName should be of type "string"');
    }
    if (sourceBucketNameAndObjectName === '') {
      throw new errors.InvalidPrefixError(`Empty source prefix`);
    }
    if (conditions != null && !(conditions instanceof CopyConditions)) {
      throw new TypeError('conditions should be of type "CopyConditions"');
    }
    const headers = {};
    headers['x-amz-copy-source'] = uriResourceEscape(sourceBucketNameAndObjectName);
    if (conditions) {
      if (conditions.modified !== '') {
        headers['x-amz-copy-source-if-modified-since'] = conditions.modified;
      }
      if (conditions.unmodified !== '') {
        headers['x-amz-copy-source-if-unmodified-since'] = conditions.unmodified;
      }
      if (conditions.matchETag !== '') {
        headers['x-amz-copy-source-if-match'] = conditions.matchETag;
      }
      if (conditions.matchETagExcept !== '') {
        headers['x-amz-copy-source-if-none-match'] = conditions.matchETagExcept;
      }
    }
    const method = 'PUT';
    const res = await this.makeRequestAsync({
      method,
      bucketName: targetBucketName,
      objectName: targetObjectName,
      headers
    });
    const body = await readAsString(res);
    return xmlParsers.parseCopyObject(body);
  }
  async copyObjectV2(sourceConfig, destConfig) {
    if (!(sourceConfig instanceof CopySourceOptions)) {
      throw new errors.InvalidArgumentError('sourceConfig should of type CopySourceOptions ');
    }
    if (!(destConfig instanceof CopyDestinationOptions)) {
      throw new errors.InvalidArgumentError('destConfig should of type CopyDestinationOptions ');
    }
    if (!destConfig.validate()) {
      return Promise.reject();
    }
    if (!destConfig.validate()) {
      return Promise.reject();
    }
    const headers = Object.assign({}, sourceConfig.getHeaders(), destConfig.getHeaders());
    const bucketName = destConfig.Bucket;
    const objectName = destConfig.Object;
    const method = 'PUT';
    const res = await this.makeRequestAsync({
      method,
      bucketName,
      objectName,
      headers
    });
    const body = await readAsString(res);
    const copyRes = xmlParsers.parseCopyObject(body);
    const resHeaders = res.headers;
    const sizeHeaderValue = resHeaders && resHeaders['content-length'];
    const size = typeof sizeHeaderValue === 'number' ? sizeHeaderValue : undefined;
    return {
      Bucket: destConfig.Bucket,
      Key: destConfig.Object,
      LastModified: copyRes.lastModified,
      MetaData: extractMetadata(resHeaders),
      VersionId: getVersionId(resHeaders),
      SourceVersionId: getSourceVersionId(resHeaders),
      Etag: sanitizeETag(resHeaders.etag),
      Size: size
    };
  }
  async copyObject(...allArgs) {
    if (typeof allArgs[0] === 'string') {
      const [targetBucketName, targetObjectName, sourceBucketNameAndObjectName, conditions] = allArgs;
      return await this.copyObjectV1(targetBucketName, targetObjectName, sourceBucketNameAndObjectName, conditions);
    }
    const [source, dest] = allArgs;
    return await this.copyObjectV2(source, dest);
  }
  async uploadPart(partConfig, payload) {
    const {
      bucketName,
      objectName,
      uploadID,
      partNumber,
      headers
    } = partConfig;
    const method = 'PUT';
    const query = `uploadId=${uploadID}&partNumber=${partNumber}`;
    const requestOptions = {
      method,
      bucketName,
      objectName: objectName,
      query,
      headers
    };
    const res = await this.makeRequestAsync(requestOptions, payload);
    const body = await readAsString(res);
    const partRes = uploadPartParser(body);
    return {
      etag: sanitizeETag(partRes.ETag),
      key: objectName,
      part: partNumber
    };
  }
  async composeObject(destObjConfig, sourceObjList) {
    const sourceFilesLength = sourceObjList.length;
    if (!Array.isArray(sourceObjList)) {
      throw new errors.InvalidArgumentError('sourceConfig should an array of CopySourceOptions ');
    }
    if (!(destObjConfig instanceof CopyDestinationOptions)) {
      throw new errors.InvalidArgumentError('destConfig should of type CopyDestinationOptions ');
    }
    if (sourceFilesLength < 1 || sourceFilesLength > PART_CONSTRAINTS.MAX_PARTS_COUNT) {
      throw new errors.InvalidArgumentError(`"There must be as least one and up to ${PART_CONSTRAINTS.MAX_PARTS_COUNT} source objects.`);
    }
    for (let i = 0; i < sourceFilesLength; i++) {
      const sObj = sourceObjList[i];
      if (!sObj.validate()) {
        return false;
      }
    }
    if (!destObjConfig.validate()) {
      return false;
    }
    const getStatOptions = srcConfig => {
      let statOpts = {};
      if (!_.isEmpty(srcConfig.VersionID)) {
        statOpts = {
          versionId: srcConfig.VersionID
        };
      }
      return statOpts;
    };
    const srcObjectSizes = [];
    let totalSize = 0;
    let totalParts = 0;
    const sourceObjStats = sourceObjList.map(srcItem => this.statObject(srcItem.Bucket, srcItem.Object, getStatOptions(srcItem)));
    const srcObjectInfos = await Promise.all(sourceObjStats);
    const validatedStats = srcObjectInfos.map((resItemStat, index) => {
      const srcConfig = sourceObjList[index];
      let srcCopySize = resItemStat.size;
      // Check if a segment is specified, and if so, is the
      // segment within object bounds?
      if (srcConfig && srcConfig.MatchRange) {
        // Since range is specified,
        //    0 <= src.srcStart <= src.srcEnd
        // so only invalid case to check is:
        const srcStart = srcConfig.Start;
        const srcEnd = srcConfig.End;
        if (srcEnd >= srcCopySize || srcStart < 0) {
          throw new errors.InvalidArgumentError(`CopySrcOptions ${index} has invalid segment-to-copy [${srcStart}, ${srcEnd}] (size is ${srcCopySize})`);
        }
        srcCopySize = srcEnd - srcStart + 1;
      }

      // Only the last source may be less than `absMinPartSize`
      if (srcCopySize < PART_CONSTRAINTS.ABS_MIN_PART_SIZE && index < sourceFilesLength - 1) {
        throw new errors.InvalidArgumentError(`CopySrcOptions ${index} is too small (${srcCopySize}) and it is not the last part.`);
      }

      // Is data to copy too large?
      totalSize += srcCopySize;
      if (totalSize > PART_CONSTRAINTS.MAX_MULTIPART_PUT_OBJECT_SIZE) {
        throw new errors.InvalidArgumentError(`Cannot compose an object of size ${totalSize} (> 5TiB)`);
      }

      // record source size
      srcObjectSizes[index] = srcCopySize;

      // calculate parts needed for current source
      totalParts += partsRequired(srcCopySize);
      // Do we need more parts than we are allowed?
      if (totalParts > PART_CONSTRAINTS.MAX_PARTS_COUNT) {
        throw new errors.InvalidArgumentError(`Your proposed compose object requires more than ${PART_CONSTRAINTS.MAX_PARTS_COUNT} parts`);
      }
      return resItemStat;
    });
    if (totalParts === 1 && totalSize <= PART_CONSTRAINTS.MAX_PART_SIZE || totalSize === 0) {
      return await this.copyObject(sourceObjList[0], destObjConfig); // use copyObjectV2
    }

    // preserve etag to avoid modification of object while copying.
    for (let i = 0; i < sourceFilesLength; i++) {
      ;
      sourceObjList[i].MatchETag = validatedStats[i].etag;
    }
    const splitPartSizeList = validatedStats.map((resItemStat, idx) => {
      return calculateEvenSplits(srcObjectSizes[idx], sourceObjList[idx]);
    });
    const getUploadPartConfigList = uploadId => {
      const uploadPartConfigList = [];
      splitPartSizeList.forEach((splitSize, splitIndex) => {
        if (splitSize) {
          const {
            startIndex: startIdx,
            endIndex: endIdx,
            objInfo: objConfig
          } = splitSize;
          const partIndex = splitIndex + 1; // part index starts from 1.
          const totalUploads = Array.from(startIdx);
          const headers = sourceObjList[splitIndex].getHeaders();
          totalUploads.forEach((splitStart, upldCtrIdx) => {
            const splitEnd = endIdx[upldCtrIdx];
            const sourceObj = `${objConfig.Bucket}/${objConfig.Object}`;
            headers['x-amz-copy-source'] = `${sourceObj}`;
            headers['x-amz-copy-source-range'] = `bytes=${splitStart}-${splitEnd}`;
            const uploadPartConfig = {
              bucketName: destObjConfig.Bucket,
              objectName: destObjConfig.Object,
              uploadID: uploadId,
              partNumber: partIndex,
              headers: headers,
              sourceObj: sourceObj
            };
            uploadPartConfigList.push(uploadPartConfig);
          });
        }
      });
      return uploadPartConfigList;
    };
    const uploadAllParts = async uploadList => {
      const partUploads = uploadList.map(async item => {
        return this.uploadPart(item);
      });
      // Process results here if needed
      return await Promise.all(partUploads);
    };
    const performUploadParts = async uploadId => {
      const uploadList = getUploadPartConfigList(uploadId);
      const partsRes = await uploadAllParts(uploadList);
      return partsRes.map(partCopy => ({
        etag: partCopy.etag,
        part: partCopy.part
      }));
    };
    const newUploadHeaders = destObjConfig.getHeaders();
    const uploadId = await this.initiateNewMultipartUpload(destObjConfig.Bucket, destObjConfig.Object, newUploadHeaders);
    try {
      const partsDone = await performUploadParts(uploadId);
      return await this.completeMultipartUpload(destObjConfig.Bucket, destObjConfig.Object, uploadId, partsDone);
    } catch (err) {
      return await this.abortMultipartUpload(destObjConfig.Bucket, destObjConfig.Object, uploadId);
    }
  }
  async presignedUrl(method, bucketName, objectName, expires, reqParams, requestDate) {
    var _requestDate;
    if (this.anonymous) {
      throw new errors.AnonymousRequestError(`Presigned ${method} url cannot be generated for anonymous requests`);
    }
    if (!expires) {
      expires = PRESIGN_EXPIRY_DAYS_MAX;
    }
    if (!reqParams) {
      reqParams = {};
    }
    if (!requestDate) {
      requestDate = new Date();
    }

    // Type assertions
    if (expires && typeof expires !== 'number') {
      throw new TypeError('expires should be of type "number"');
    }
    if (reqParams && typeof reqParams !== 'object') {
      throw new TypeError('reqParams should be of type "object"');
    }
    if (requestDate && !(requestDate instanceof Date) || requestDate && isNaN((_requestDate = requestDate) === null || _requestDate === void 0 ? void 0 : _requestDate.getTime())) {
      throw new TypeError('requestDate should be of type "Date" and valid');
    }
    const query = reqParams ? qs.stringify(reqParams) : undefined;
    try {
      const region = await this.getBucketRegionAsync(bucketName);
      await this.checkAndRefreshCreds();
      const reqOptions = this.getRequestOptions({
        method,
        region,
        bucketName,
        objectName,
        query
      });
      return presignSignatureV4(reqOptions, this.accessKey, this.secretKey, this.sessionToken, region, requestDate, expires);
    } catch (err) {
      if (err instanceof errors.InvalidBucketNameError) {
        throw new errors.InvalidArgumentError(`Unable to get bucket region for ${bucketName}.`);
      }
      throw err;
    }
  }
  async presignedGetObject(bucketName, objectName, expires, respHeaders, requestDate) {
    if (!isValidBucketName(bucketName)) {
      throw new errors.InvalidBucketNameError('Invalid bucket name: ' + bucketName);
    }
    if (!isValidObjectName(objectName)) {
      throw new errors.InvalidObjectNameError(`Invalid object name: ${objectName}`);
    }
    const validRespHeaders = ['response-content-type', 'response-content-language', 'response-expires', 'response-cache-control', 'response-content-disposition', 'response-content-encoding'];
    validRespHeaders.forEach(header => {
      // @ts-ignore
      if (respHeaders !== undefined && respHeaders[header] !== undefined && !isString(respHeaders[header])) {
        throw new TypeError(`response header ${header} should be of type "string"`);
      }
    });
    return this.presignedUrl('GET', bucketName, objectName, expires, respHeaders, requestDate);
  }
  async presignedPutObject(bucketName, objectName, expires) {
    if (!isValidBucketName(bucketName)) {
      throw new errors.InvalidBucketNameError(`Invalid bucket name: ${bucketName}`);
    }
    if (!isValidObjectName(objectName)) {
      throw new errors.InvalidObjectNameError(`Invalid object name: ${objectName}`);
    }
    return this.presignedUrl('PUT', bucketName, objectName, expires);
  }
  newPostPolicy() {
    return new PostPolicy();
  }
  async presignedPostPolicy(postPolicy) {
    if (this.anonymous) {
      throw new errors.AnonymousRequestError('Presigned POST policy cannot be generated for anonymous requests');
    }
    if (!isObject(postPolicy)) {
      throw new TypeError('postPolicy should be of type "object"');
    }
    const bucketName = postPolicy.formData.bucket;
    try {
      const region = await this.getBucketRegionAsync(bucketName);
      const date = new Date();
      const dateStr = makeDateLong(date);
      await this.checkAndRefreshCreds();
      if (!postPolicy.policy.expiration) {
        // 'expiration' is mandatory field for S3.
        // Set default expiration date of 7 days.
        const expires = new Date();
        expires.setSeconds(PRESIGN_EXPIRY_DAYS_MAX);
        postPolicy.setExpires(expires);
      }
      postPolicy.policy.conditions.push(['eq', '$x-amz-date', dateStr]);
      postPolicy.formData['x-amz-date'] = dateStr;
      postPolicy.policy.conditions.push(['eq', '$x-amz-algorithm', 'AWS4-HMAC-SHA256']);
      postPolicy.formData['x-amz-algorithm'] = 'AWS4-HMAC-SHA256';
      postPolicy.policy.conditions.push(['eq', '$x-amz-credential', this.accessKey + '/' + getScope(region, date)]);
      postPolicy.formData['x-amz-credential'] = this.accessKey + '/' + getScope(region, date);
      if (this.sessionToken) {
        postPolicy.policy.conditions.push(['eq', '$x-amz-security-token', this.sessionToken]);
        postPolicy.formData['x-amz-security-token'] = this.sessionToken;
      }
      const policyBase64 = Buffer.from(JSON.stringify(postPolicy.policy)).toString('base64');
      postPolicy.formData.policy = policyBase64;
      postPolicy.formData['x-amz-signature'] = postPresignSignatureV4(region, date, this.secretKey, policyBase64);
      const opts = {
        region: region,
        bucketName: bucketName,
        method: 'POST'
      };
      const reqOptions = this.getRequestOptions(opts);
      const portStr = this.port == 80 || this.port === 443 ? '' : `:${this.port.toString()}`;
      const urlStr = `${reqOptions.protocol}//${reqOptions.host}${portStr}${reqOptions.path}`;
      return {
        postURL: urlStr,
        formData: postPolicy.formData
      };
    } catch (err) {
      if (err instanceof errors.InvalidBucketNameError) {
        throw new errors.InvalidArgumentError(`Unable to get bucket region for ${bucketName}.`);
      }
      throw err;
    }
  }
  // list a batch of objects
  async listObjectsQuery(bucketName, prefix, marker, listQueryOpts) {
    if (!isValidBucketName(bucketName)) {
      throw new errors.InvalidBucketNameError('Invalid bucket name: ' + bucketName);
    }
    if (!isString(prefix)) {
      throw new TypeError('prefix should be of type "string"');
    }
    if (marker && !isString(marker)) {
      throw new TypeError('marker should be of type "string"');
    }
    if (listQueryOpts && !isObject(listQueryOpts)) {
      throw new TypeError('listQueryOpts should be of type "object"');
    }
    let {
      Delimiter,
      MaxKeys,
      IncludeVersion,
      versionIdMarker,
      keyMarker
    } = listQueryOpts;
    if (!isString(Delimiter)) {
      throw new TypeError('Delimiter should be of type "string"');
    }
    if (!isNumber(MaxKeys)) {
      throw new TypeError('MaxKeys should be of type "number"');
    }
    const queries = [];
    // escape every value in query string, except maxKeys
    queries.push(`prefix=${uriEscape(prefix)}`);
    queries.push(`delimiter=${uriEscape(Delimiter)}`);
    queries.push(`encoding-type=url`);
    if (IncludeVersion) {
      queries.push(`versions`);
    }
    if (IncludeVersion) {
      // v1 version listing..
      if (keyMarker) {
        queries.push(`key-marker=${keyMarker}`);
      }
      if (versionIdMarker) {
        queries.push(`version-id-marker=${versionIdMarker}`);
      }
    } else if (marker) {
      marker = uriEscape(marker);
      queries.push(`marker=${marker}`);
    }

    // no need to escape maxKeys
    if (MaxKeys) {
      if (MaxKeys >= 1000) {
        MaxKeys = 1000;
      }
      queries.push(`max-keys=${MaxKeys}`);
    }
    queries.sort();
    let query = '';
    if (queries.length > 0) {
      query = `${queries.join('&')}`;
    }
    const method = 'GET';
    const res = await this.makeRequestAsync({
      method,
      bucketName,
      query
    });
    const body = await readAsString(res);
    const listQryList = parseListObjects(body);
    return listQryList;
  }
  listObjects(bucketName, prefix, recursive, listOpts) {
    if (prefix === undefined) {
      prefix = '';
    }
    if (recursive === undefined) {
      recursive = false;
    }
    if (!isValidBucketName(bucketName)) {
      throw new errors.InvalidBucketNameError('Invalid bucket name: ' + bucketName);
    }
    if (!isValidPrefix(prefix)) {
      throw new errors.InvalidPrefixError(`Invalid prefix : ${prefix}`);
    }
    if (!isString(prefix)) {
      throw new TypeError('prefix should be of type "string"');
    }
    if (!isBoolean(recursive)) {
      throw new TypeError('recursive should be of type "boolean"');
    }
    if (listOpts && !isObject(listOpts)) {
      throw new TypeError('listOpts should be of type "object"');
    }
    let marker = '';
    let keyMarker = '';
    let versionIdMarker = '';
    let objects = [];
    let ended = false;
    const readStream = new stream.Readable({
      objectMode: true
    });
    readStream._read = async () => {
      // push one object per _read()
      if (objects.length) {
        readStream.push(objects.shift());
        return;
      }
      if (ended) {
        return readStream.push(null);
      }
      try {
        const listQueryOpts = {
          Delimiter: recursive ? '' : '/',
          // if recursive is false set delimiter to '/'
          MaxKeys: 1000,
          IncludeVersion: listOpts === null || listOpts === void 0 ? void 0 : listOpts.IncludeVersion,
          // version listing specific options
          keyMarker: keyMarker,
          versionIdMarker: versionIdMarker
        };
        const result = await this.listObjectsQuery(bucketName, prefix, marker, listQueryOpts);
        if (result.isTruncated) {
          marker = result.nextMarker || undefined;
          if (result.keyMarker) {
            keyMarker = result.keyMarker;
          }
          if (result.versionIdMarker) {
            versionIdMarker = result.versionIdMarker;
          }
        } else {
          ended = true;
        }
        if (result.objects) {
          objects = result.objects;
        }
        // @ts-ignore
        readStream._read();
      } catch (err) {
        readStream.emit('error', err);
      }
    };
    return readStream;
  }
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJjcnlwdG8iLCJmcyIsImh0dHAiLCJodHRwcyIsInBhdGgiLCJzdHJlYW0iLCJhc3luYyIsIkJsb2NrU3RyZWFtMiIsImlzQnJvd3NlciIsIl8iLCJxcyIsInhtbDJqcyIsIkNyZWRlbnRpYWxQcm92aWRlciIsImVycm9ycyIsIkNvcHlEZXN0aW5hdGlvbk9wdGlvbnMiLCJDb3B5U291cmNlT3B0aW9ucyIsIkRFRkFVTFRfUkVHSU9OIiwiTEVHQUxfSE9MRF9TVEFUVVMiLCJQUkVTSUdOX0VYUElSWV9EQVlTX01BWCIsIlJFVEVOVElPTl9NT0RFUyIsIlJFVEVOVElPTl9WQUxJRElUWV9VTklUUyIsInBvc3RQcmVzaWduU2lnbmF0dXJlVjQiLCJwcmVzaWduU2lnbmF0dXJlVjQiLCJzaWduVjQiLCJmc3AiLCJzdHJlYW1Qcm9taXNlIiwiQ29weUNvbmRpdGlvbnMiLCJFeHRlbnNpb25zIiwiY2FsY3VsYXRlRXZlblNwbGl0cyIsImV4dHJhY3RNZXRhZGF0YSIsImdldENvbnRlbnRMZW5ndGgiLCJnZXRTY29wZSIsImdldFNvdXJjZVZlcnNpb25JZCIsImdldFZlcnNpb25JZCIsImhhc2hCaW5hcnkiLCJpbnNlcnRDb250ZW50VHlwZSIsImlzQW1hem9uRW5kcG9pbnQiLCJpc0Jvb2xlYW4iLCJpc0RlZmluZWQiLCJpc0VtcHR5IiwiaXNOdW1iZXIiLCJpc09iamVjdCIsImlzUGxhaW5PYmplY3QiLCJpc1JlYWRhYmxlU3RyZWFtIiwiaXNTdHJpbmciLCJpc1ZhbGlkQnVja2V0TmFtZSIsImlzVmFsaWRFbmRwb2ludCIsImlzVmFsaWRPYmplY3ROYW1lIiwiaXNWYWxpZFBvcnQiLCJpc1ZhbGlkUHJlZml4IiwiaXNWaXJ0dWFsSG9zdFN0eWxlIiwibWFrZURhdGVMb25nIiwiUEFSVF9DT05TVFJBSU5UUyIsInBhcnRzUmVxdWlyZWQiLCJwcmVwZW5kWEFNWk1ldGEiLCJyZWFkYWJsZVN0cmVhbSIsInNhbml0aXplRVRhZyIsInRvTWQ1IiwidG9TaGEyNTYiLCJ1cmlFc2NhcGUiLCJ1cmlSZXNvdXJjZUVzY2FwZSIsImpvaW5Ib3N0UG9ydCIsIlBvc3RQb2xpY3kiLCJyZXF1ZXN0V2l0aFJldHJ5IiwiZHJhaW5SZXNwb25zZSIsInJlYWRBc0J1ZmZlciIsInJlYWRBc1N0cmluZyIsImdldFMzRW5kcG9pbnQiLCJwYXJzZUNvbXBsZXRlTXVsdGlwYXJ0IiwicGFyc2VJbml0aWF0ZU11bHRpcGFydCIsInBhcnNlTGlzdE9iamVjdHMiLCJwYXJzZU9iamVjdExlZ2FsSG9sZENvbmZpZyIsInBhcnNlU2VsZWN0T2JqZWN0Q29udGVudFJlc3BvbnNlIiwidXBsb2FkUGFydFBhcnNlciIsInhtbFBhcnNlcnMiLCJ4bWwiLCJCdWlsZGVyIiwicmVuZGVyT3B0cyIsInByZXR0eSIsImhlYWRsZXNzIiwiUGFja2FnZSIsInZlcnNpb24iLCJyZXF1ZXN0T3B0aW9uUHJvcGVydGllcyIsIlR5cGVkQ2xpZW50IiwicGFydFNpemUiLCJtYXhpbXVtUGFydFNpemUiLCJtYXhPYmplY3RTaXplIiwiY29uc3RydWN0b3IiLCJwYXJhbXMiLCJzZWN1cmUiLCJ1bmRlZmluZWQiLCJFcnJvciIsInVzZVNTTCIsInBvcnQiLCJlbmRQb2ludCIsIkludmFsaWRFbmRwb2ludEVycm9yIiwiSW52YWxpZEFyZ3VtZW50RXJyb3IiLCJyZWdpb24iLCJob3N0IiwidG9Mb3dlckNhc2UiLCJwcm90b2NvbCIsInRyYW5zcG9ydCIsInRyYW5zcG9ydEFnZW50IiwiZ2xvYmFsQWdlbnQiLCJsaWJyYXJ5Q29tbWVudHMiLCJwcm9jZXNzIiwicGxhdGZvcm0iLCJhcmNoIiwibGlicmFyeUFnZW50IiwidXNlckFnZW50IiwicGF0aFN0eWxlIiwiYWNjZXNzS2V5Iiwic2VjcmV0S2V5Iiwic2Vzc2lvblRva2VuIiwiYW5vbnltb3VzIiwiY3JlZGVudGlhbHNQcm92aWRlciIsInJlZ2lvbk1hcCIsIm92ZXJSaWRlUGFydFNpemUiLCJlbmFibGVTSEEyNTYiLCJzM0FjY2VsZXJhdGVFbmRwb2ludCIsInJlcU9wdGlvbnMiLCJjbGllbnRFeHRlbnNpb25zIiwiZXh0ZW5zaW9ucyIsInNldFMzVHJhbnNmZXJBY2NlbGVyYXRlIiwic2V0UmVxdWVzdE9wdGlvbnMiLCJvcHRpb25zIiwiVHlwZUVycm9yIiwicGljayIsImdldEFjY2VsZXJhdGVFbmRQb2ludElmU2V0IiwiYnVja2V0TmFtZSIsIm9iamVjdE5hbWUiLCJpbmNsdWRlcyIsInNldEFwcEluZm8iLCJhcHBOYW1lIiwiYXBwVmVyc2lvbiIsInRyaW0iLCJnZXRSZXF1ZXN0T3B0aW9ucyIsIm9wdHMiLCJtZXRob2QiLCJoZWFkZXJzIiwicXVlcnkiLCJhZ2VudCIsInZpcnR1YWxIb3N0U3R5bGUiLCJhY2NlbGVyYXRlRW5kUG9pbnQiLCJrIiwidiIsIk9iamVjdCIsImVudHJpZXMiLCJhc3NpZ24iLCJtYXBWYWx1ZXMiLCJwaWNrQnkiLCJ0b1N0cmluZyIsInNldENyZWRlbnRpYWxzUHJvdmlkZXIiLCJjaGVja0FuZFJlZnJlc2hDcmVkcyIsImNyZWRlbnRpYWxzQ29uZiIsImdldENyZWRlbnRpYWxzIiwiZ2V0QWNjZXNzS2V5IiwiZ2V0U2VjcmV0S2V5IiwiZ2V0U2Vzc2lvblRva2VuIiwiZSIsImNhdXNlIiwibG9nSFRUUCIsInJlc3BvbnNlIiwiZXJyIiwibG9nU3RyZWFtIiwibG9nSGVhZGVycyIsImZvckVhY2giLCJyZWRhY3RvciIsIlJlZ0V4cCIsInJlcGxhY2UiLCJ3cml0ZSIsInN0YXR1c0NvZGUiLCJlcnJKU09OIiwiSlNPTiIsInN0cmluZ2lmeSIsInRyYWNlT24iLCJzdGRvdXQiLCJ0cmFjZU9mZiIsIm1ha2VSZXF1ZXN0QXN5bmMiLCJwYXlsb2FkIiwiZXhwZWN0ZWRDb2RlcyIsImxlbmd0aCIsInNoYTI1NnN1bSIsIm1ha2VSZXF1ZXN0U3RyZWFtQXN5bmMiLCJtYWtlUmVxdWVzdEFzeW5jT21pdCIsInN0YXR1c0NvZGVzIiwicmVzIiwiYm9keSIsIkJ1ZmZlciIsImlzQnVmZmVyIiwiZ2V0QnVja2V0UmVnaW9uQXN5bmMiLCJkYXRlIiwiRGF0ZSIsImF1dGhvcml6YXRpb24iLCJwYXJzZVJlc3BvbnNlRXJyb3IiLCJJbnZhbGlkQnVja2V0TmFtZUVycm9yIiwiY2FjaGVkIiwiZXh0cmFjdFJlZ2lvbkFzeW5jIiwicGFyc2VCdWNrZXRSZWdpb24iLCJTM0Vycm9yIiwiZXJyQ29kZSIsImNvZGUiLCJlcnJSZWdpb24iLCJuYW1lIiwiUmVnaW9uIiwibWFrZVJlcXVlc3QiLCJyZXR1cm5SZXNwb25zZSIsImNiIiwicHJvbSIsInRoZW4iLCJyZXN1bHQiLCJtYWtlUmVxdWVzdFN0cmVhbSIsImV4ZWN1dG9yIiwiZ2V0QnVja2V0UmVnaW9uIiwibWFrZUJ1Y2tldCIsIm1ha2VPcHRzIiwiYnVpbGRPYmplY3QiLCJDcmVhdGVCdWNrZXRDb25maWd1cmF0aW9uIiwiJCIsInhtbG5zIiwiTG9jYXRpb25Db25zdHJhaW50IiwiT2JqZWN0TG9ja2luZyIsImZpbmFsUmVnaW9uIiwicmVxdWVzdE9wdCIsImJ1Y2tldEV4aXN0cyIsInJlbW92ZUJ1Y2tldCIsImdldE9iamVjdCIsImdldE9wdHMiLCJJbnZhbGlkT2JqZWN0TmFtZUVycm9yIiwiZ2V0UGFydGlhbE9iamVjdCIsIm9mZnNldCIsInJhbmdlIiwic3NlSGVhZGVycyIsIlNTRUN1c3RvbWVyQWxnb3JpdGhtIiwiU1NFQ3VzdG9tZXJLZXkiLCJTU0VDdXN0b21lcktleU1ENSIsImV4cGVjdGVkU3RhdHVzQ29kZXMiLCJwdXNoIiwiZkdldE9iamVjdCIsImZpbGVQYXRoIiwiZG93bmxvYWRUb1RtcEZpbGUiLCJwYXJ0RmlsZVN0cmVhbSIsIm9ialN0YXQiLCJzdGF0T2JqZWN0IiwiZW5jb2RlZEV0YWciLCJmcm9tIiwiZXRhZyIsInBhcnRGaWxlIiwibWtkaXIiLCJkaXJuYW1lIiwicmVjdXJzaXZlIiwic3RhdHMiLCJzdGF0Iiwic2l6ZSIsImNyZWF0ZVdyaXRlU3RyZWFtIiwiZmxhZ3MiLCJkb3dubG9hZFN0cmVhbSIsInBpcGVsaW5lIiwicmVuYW1lIiwic3RhdE9wdHMiLCJzdGF0T3B0RGVmIiwicGFyc2VJbnQiLCJtZXRhRGF0YSIsImxhc3RNb2RpZmllZCIsInZlcnNpb25JZCIsInJlbW92ZU9iamVjdCIsInJlbW92ZU9wdHMiLCJnb3Zlcm5hbmNlQnlwYXNzIiwiZm9yY2VEZWxldGUiLCJxdWVyeVBhcmFtcyIsImxpc3RJbmNvbXBsZXRlVXBsb2FkcyIsImJ1Y2tldCIsInByZWZpeCIsIkludmFsaWRQcmVmaXhFcnJvciIsImRlbGltaXRlciIsImtleU1hcmtlciIsInVwbG9hZElkTWFya2VyIiwidXBsb2FkcyIsImVuZGVkIiwicmVhZFN0cmVhbSIsIlJlYWRhYmxlIiwib2JqZWN0TW9kZSIsIl9yZWFkIiwic2hpZnQiLCJsaXN0SW5jb21wbGV0ZVVwbG9hZHNRdWVyeSIsInByZWZpeGVzIiwiZWFjaFNlcmllcyIsInVwbG9hZCIsImxpc3RQYXJ0cyIsImtleSIsInVwbG9hZElkIiwicGFydHMiLCJyZWR1Y2UiLCJhY2MiLCJpdGVtIiwiZW1pdCIsImlzVHJ1bmNhdGVkIiwibmV4dEtleU1hcmtlciIsIm5leHRVcGxvYWRJZE1hcmtlciIsInF1ZXJpZXMiLCJtYXhVcGxvYWRzIiwic29ydCIsInVuc2hpZnQiLCJqb2luIiwicGFyc2VMaXN0TXVsdGlwYXJ0IiwiaW5pdGlhdGVOZXdNdWx0aXBhcnRVcGxvYWQiLCJhYm9ydE11bHRpcGFydFVwbG9hZCIsInJlcXVlc3RPcHRpb25zIiwiZmluZFVwbG9hZElkIiwiX2xhdGVzdFVwbG9hZCIsImxhdGVzdFVwbG9hZCIsImluaXRpYXRlZCIsImdldFRpbWUiLCJjb21wbGV0ZU11bHRpcGFydFVwbG9hZCIsImV0YWdzIiwiYnVpbGRlciIsIkNvbXBsZXRlTXVsdGlwYXJ0VXBsb2FkIiwiUGFydCIsIm1hcCIsIlBhcnROdW1iZXIiLCJwYXJ0IiwiRVRhZyIsImVyck1lc3NhZ2UiLCJtYXJrZXIiLCJsaXN0UGFydHNRdWVyeSIsInBhcnNlTGlzdFBhcnRzIiwibGlzdEJ1Y2tldHMiLCJyZWdpb25Db25mIiwiaHR0cFJlcyIsInhtbFJlc3VsdCIsInBhcnNlTGlzdEJ1Y2tldCIsImNhbGN1bGF0ZVBhcnRTaXplIiwiZlB1dE9iamVjdCIsInB1dE9iamVjdCIsImNyZWF0ZVJlYWRTdHJlYW0iLCJzdGF0U2l6ZSIsInVwbG9hZEJ1ZmZlciIsImJ1ZiIsInVwbG9hZFN0cmVhbSIsIm1kNXN1bSIsIm9sZFBhcnRzIiwiZVRhZ3MiLCJwcmV2aW91c1VwbG9hZElkIiwib2xkVGFncyIsImNodW5raWVyIiwiemVyb1BhZGRpbmciLCJvIiwiUHJvbWlzZSIsImFsbCIsInJlc29sdmUiLCJyZWplY3QiLCJwaXBlIiwib24iLCJwYXJ0TnVtYmVyIiwiY2h1bmsiLCJtZDUiLCJjcmVhdGVIYXNoIiwidXBkYXRlIiwiZGlnZXN0Iiwib2xkUGFydCIsInJlbW92ZUJ1Y2tldFJlcGxpY2F0aW9uIiwic2V0QnVja2V0UmVwbGljYXRpb24iLCJyZXBsaWNhdGlvbkNvbmZpZyIsInJvbGUiLCJydWxlcyIsInJlcGxpY2F0aW9uUGFyYW1zQ29uZmlnIiwiUmVwbGljYXRpb25Db25maWd1cmF0aW9uIiwiUm9sZSIsIlJ1bGUiLCJnZXRCdWNrZXRSZXBsaWNhdGlvbiIsInBhcnNlUmVwbGljYXRpb25Db25maWciLCJnZXRPYmplY3RMZWdhbEhvbGQiLCJrZXlzIiwic3RyUmVzIiwic2V0T2JqZWN0TGVnYWxIb2xkIiwic2V0T3B0cyIsInN0YXR1cyIsIkVOQUJMRUQiLCJESVNBQkxFRCIsImNvbmZpZyIsIlN0YXR1cyIsInJvb3ROYW1lIiwiZ2V0QnVja2V0VGFnZ2luZyIsInBhcnNlVGFnZ2luZyIsImdldE9iamVjdFRhZ2dpbmciLCJzZXRCdWNrZXRQb2xpY3kiLCJwb2xpY3kiLCJJbnZhbGlkQnVja2V0UG9saWN5RXJyb3IiLCJnZXRCdWNrZXRQb2xpY3kiLCJwdXRPYmplY3RSZXRlbnRpb24iLCJyZXRlbnRpb25PcHRzIiwibW9kZSIsIkNPTVBMSUFOQ0UiLCJHT1ZFUk5BTkNFIiwicmV0YWluVW50aWxEYXRlIiwiTW9kZSIsIlJldGFpblVudGlsRGF0ZSIsImdldE9iamVjdExvY2tDb25maWciLCJwYXJzZU9iamVjdExvY2tDb25maWciLCJzZXRPYmplY3RMb2NrQ29uZmlnIiwibG9ja0NvbmZpZ09wdHMiLCJyZXRlbnRpb25Nb2RlcyIsInZhbGlkVW5pdHMiLCJEQVlTIiwiWUVBUlMiLCJ1bml0IiwidmFsaWRpdHkiLCJPYmplY3RMb2NrRW5hYmxlZCIsImNvbmZpZ0tleXMiLCJpc0FsbEtleXNTZXQiLCJldmVyeSIsImxjayIsIkRlZmF1bHRSZXRlbnRpb24iLCJEYXlzIiwiWWVhcnMiLCJnZXRCdWNrZXRWZXJzaW9uaW5nIiwicGFyc2VCdWNrZXRWZXJzaW9uaW5nQ29uZmlnIiwic2V0QnVja2V0VmVyc2lvbmluZyIsInZlcnNpb25Db25maWciLCJzZXRUYWdnaW5nIiwidGFnZ2luZ1BhcmFtcyIsInRhZ3MiLCJwdXRPcHRzIiwidGFnc0xpc3QiLCJ2YWx1ZSIsIktleSIsIlZhbHVlIiwidGFnZ2luZ0NvbmZpZyIsIlRhZ2dpbmciLCJUYWdTZXQiLCJUYWciLCJwYXlsb2FkQnVmIiwicmVtb3ZlVGFnZ2luZyIsInNldEJ1Y2tldFRhZ2dpbmciLCJyZW1vdmVCdWNrZXRUYWdnaW5nIiwic2V0T2JqZWN0VGFnZ2luZyIsInJlbW92ZU9iamVjdFRhZ2dpbmciLCJzZWxlY3RPYmplY3RDb250ZW50Iiwic2VsZWN0T3B0cyIsImV4cHJlc3Npb24iLCJpbnB1dFNlcmlhbGl6YXRpb24iLCJvdXRwdXRTZXJpYWxpemF0aW9uIiwiRXhwcmVzc2lvbiIsIkV4cHJlc3Npb25UeXBlIiwiZXhwcmVzc2lvblR5cGUiLCJJbnB1dFNlcmlhbGl6YXRpb24iLCJPdXRwdXRTZXJpYWxpemF0aW9uIiwicmVxdWVzdFByb2dyZXNzIiwiUmVxdWVzdFByb2dyZXNzIiwic2NhblJhbmdlIiwiU2NhblJhbmdlIiwiYXBwbHlCdWNrZXRMaWZlY3ljbGUiLCJwb2xpY3lDb25maWciLCJyZW1vdmVCdWNrZXRMaWZlY3ljbGUiLCJzZXRCdWNrZXRMaWZlY3ljbGUiLCJsaWZlQ3ljbGVDb25maWciLCJnZXRCdWNrZXRMaWZlY3ljbGUiLCJwYXJzZUxpZmVjeWNsZUNvbmZpZyIsInNldEJ1Y2tldEVuY3J5cHRpb24iLCJlbmNyeXB0aW9uQ29uZmlnIiwiZW5jcnlwdGlvbk9iaiIsIkFwcGx5U2VydmVyU2lkZUVuY3J5cHRpb25CeURlZmF1bHQiLCJTU0VBbGdvcml0aG0iLCJnZXRCdWNrZXRFbmNyeXB0aW9uIiwicGFyc2VCdWNrZXRFbmNyeXB0aW9uQ29uZmlnIiwicmVtb3ZlQnVja2V0RW5jcnlwdGlvbiIsImdldE9iamVjdFJldGVudGlvbiIsInBhcnNlT2JqZWN0UmV0ZW50aW9uQ29uZmlnIiwicmVtb3ZlT2JqZWN0cyIsIm9iamVjdHNMaXN0IiwiQXJyYXkiLCJpc0FycmF5IiwicnVuRGVsZXRlT2JqZWN0cyIsImJhdGNoIiwiZGVsT2JqZWN0cyIsIlZlcnNpb25JZCIsInJlbU9iamVjdHMiLCJEZWxldGUiLCJRdWlldCIsInJlbW92ZU9iamVjdHNQYXJzZXIiLCJtYXhFbnRyaWVzIiwiYmF0Y2hlcyIsImkiLCJzbGljZSIsImJhdGNoUmVzdWx0cyIsImZsYXQiLCJyZW1vdmVJbmNvbXBsZXRlVXBsb2FkIiwiSXNWYWxpZEJ1Y2tldE5hbWVFcnJvciIsInJlbW92ZVVwbG9hZElkIiwiY29weU9iamVjdFYxIiwidGFyZ2V0QnVja2V0TmFtZSIsInRhcmdldE9iamVjdE5hbWUiLCJzb3VyY2VCdWNrZXROYW1lQW5kT2JqZWN0TmFtZSIsImNvbmRpdGlvbnMiLCJtb2RpZmllZCIsInVubW9kaWZpZWQiLCJtYXRjaEVUYWciLCJtYXRjaEVUYWdFeGNlcHQiLCJwYXJzZUNvcHlPYmplY3QiLCJjb3B5T2JqZWN0VjIiLCJzb3VyY2VDb25maWciLCJkZXN0Q29uZmlnIiwidmFsaWRhdGUiLCJnZXRIZWFkZXJzIiwiQnVja2V0IiwiY29weVJlcyIsInJlc0hlYWRlcnMiLCJzaXplSGVhZGVyVmFsdWUiLCJMYXN0TW9kaWZpZWQiLCJNZXRhRGF0YSIsIlNvdXJjZVZlcnNpb25JZCIsIkV0YWciLCJTaXplIiwiY29weU9iamVjdCIsImFsbEFyZ3MiLCJzb3VyY2UiLCJkZXN0IiwidXBsb2FkUGFydCIsInBhcnRDb25maWciLCJ1cGxvYWRJRCIsInBhcnRSZXMiLCJjb21wb3NlT2JqZWN0IiwiZGVzdE9iakNvbmZpZyIsInNvdXJjZU9iakxpc3QiLCJzb3VyY2VGaWxlc0xlbmd0aCIsIk1BWF9QQVJUU19DT1VOVCIsInNPYmoiLCJnZXRTdGF0T3B0aW9ucyIsInNyY0NvbmZpZyIsIlZlcnNpb25JRCIsInNyY09iamVjdFNpemVzIiwidG90YWxTaXplIiwidG90YWxQYXJ0cyIsInNvdXJjZU9ialN0YXRzIiwic3JjSXRlbSIsInNyY09iamVjdEluZm9zIiwidmFsaWRhdGVkU3RhdHMiLCJyZXNJdGVtU3RhdCIsImluZGV4Iiwic3JjQ29weVNpemUiLCJNYXRjaFJhbmdlIiwic3JjU3RhcnQiLCJTdGFydCIsInNyY0VuZCIsIkVuZCIsIkFCU19NSU5fUEFSVF9TSVpFIiwiTUFYX01VTFRJUEFSVF9QVVRfT0JKRUNUX1NJWkUiLCJNQVhfUEFSVF9TSVpFIiwiTWF0Y2hFVGFnIiwic3BsaXRQYXJ0U2l6ZUxpc3QiLCJpZHgiLCJnZXRVcGxvYWRQYXJ0Q29uZmlnTGlzdCIsInVwbG9hZFBhcnRDb25maWdMaXN0Iiwic3BsaXRTaXplIiwic3BsaXRJbmRleCIsInN0YXJ0SW5kZXgiLCJzdGFydElkeCIsImVuZEluZGV4IiwiZW5kSWR4Iiwib2JqSW5mbyIsIm9iakNvbmZpZyIsInBhcnRJbmRleCIsInRvdGFsVXBsb2FkcyIsInNwbGl0U3RhcnQiLCJ1cGxkQ3RySWR4Iiwic3BsaXRFbmQiLCJzb3VyY2VPYmoiLCJ1cGxvYWRQYXJ0Q29uZmlnIiwidXBsb2FkQWxsUGFydHMiLCJ1cGxvYWRMaXN0IiwicGFydFVwbG9hZHMiLCJwZXJmb3JtVXBsb2FkUGFydHMiLCJwYXJ0c1JlcyIsInBhcnRDb3B5IiwibmV3VXBsb2FkSGVhZGVycyIsInBhcnRzRG9uZSIsInByZXNpZ25lZFVybCIsImV4cGlyZXMiLCJyZXFQYXJhbXMiLCJyZXF1ZXN0RGF0ZSIsIl9yZXF1ZXN0RGF0ZSIsIkFub255bW91c1JlcXVlc3RFcnJvciIsImlzTmFOIiwicHJlc2lnbmVkR2V0T2JqZWN0IiwicmVzcEhlYWRlcnMiLCJ2YWxpZFJlc3BIZWFkZXJzIiwiaGVhZGVyIiwicHJlc2lnbmVkUHV0T2JqZWN0IiwibmV3UG9zdFBvbGljeSIsInByZXNpZ25lZFBvc3RQb2xpY3kiLCJwb3N0UG9saWN5IiwiZm9ybURhdGEiLCJkYXRlU3RyIiwiZXhwaXJhdGlvbiIsInNldFNlY29uZHMiLCJzZXRFeHBpcmVzIiwicG9saWN5QmFzZTY0IiwicG9ydFN0ciIsInVybFN0ciIsInBvc3RVUkwiLCJsaXN0T2JqZWN0c1F1ZXJ5IiwibGlzdFF1ZXJ5T3B0cyIsIkRlbGltaXRlciIsIk1heEtleXMiLCJJbmNsdWRlVmVyc2lvbiIsInZlcnNpb25JZE1hcmtlciIsImxpc3RRcnlMaXN0IiwibGlzdE9iamVjdHMiLCJsaXN0T3B0cyIsIm9iamVjdHMiLCJuZXh0TWFya2VyIl0sInNvdXJjZXMiOlsiY2xpZW50LnRzIl0sInNvdXJjZXNDb250ZW50IjpbImltcG9ydCAqIGFzIGNyeXB0byBmcm9tICdub2RlOmNyeXB0bydcbmltcG9ydCAqIGFzIGZzIGZyb20gJ25vZGU6ZnMnXG5pbXBvcnQgdHlwZSB7IEluY29taW5nSHR0cEhlYWRlcnMgfSBmcm9tICdub2RlOmh0dHAnXG5pbXBvcnQgKiBhcyBodHRwIGZyb20gJ25vZGU6aHR0cCdcbmltcG9ydCAqIGFzIGh0dHBzIGZyb20gJ25vZGU6aHR0cHMnXG5pbXBvcnQgKiBhcyBwYXRoIGZyb20gJ25vZGU6cGF0aCdcbmltcG9ydCAqIGFzIHN0cmVhbSBmcm9tICdub2RlOnN0cmVhbSdcblxuaW1wb3J0ICogYXMgYXN5bmMgZnJvbSAnYXN5bmMnXG5pbXBvcnQgQmxvY2tTdHJlYW0yIGZyb20gJ2Jsb2NrLXN0cmVhbTInXG5pbXBvcnQgeyBpc0Jyb3dzZXIgfSBmcm9tICdicm93c2VyLW9yLW5vZGUnXG5pbXBvcnQgXyBmcm9tICdsb2Rhc2gnXG5pbXBvcnQgKiBhcyBxcyBmcm9tICdxdWVyeS1zdHJpbmcnXG5pbXBvcnQgeG1sMmpzIGZyb20gJ3htbDJqcydcblxuaW1wb3J0IHsgQ3JlZGVudGlhbFByb3ZpZGVyIH0gZnJvbSAnLi4vQ3JlZGVudGlhbFByb3ZpZGVyLnRzJ1xuaW1wb3J0ICogYXMgZXJyb3JzIGZyb20gJy4uL2Vycm9ycy50cydcbmltcG9ydCB0eXBlIHsgU2VsZWN0UmVzdWx0cyB9IGZyb20gJy4uL2hlbHBlcnMudHMnXG5pbXBvcnQge1xuICBDb3B5RGVzdGluYXRpb25PcHRpb25zLFxuICBDb3B5U291cmNlT3B0aW9ucyxcbiAgREVGQVVMVF9SRUdJT04sXG4gIExFR0FMX0hPTERfU1RBVFVTLFxuICBQUkVTSUdOX0VYUElSWV9EQVlTX01BWCxcbiAgUkVURU5USU9OX01PREVTLFxuICBSRVRFTlRJT05fVkFMSURJVFlfVU5JVFMsXG59IGZyb20gJy4uL2hlbHBlcnMudHMnXG5pbXBvcnQgdHlwZSB7IFBvc3RQb2xpY3lSZXN1bHQgfSBmcm9tICcuLi9taW5pby50cydcbmltcG9ydCB7IHBvc3RQcmVzaWduU2lnbmF0dXJlVjQsIHByZXNpZ25TaWduYXR1cmVWNCwgc2lnblY0IH0gZnJvbSAnLi4vc2lnbmluZy50cydcbmltcG9ydCB7IGZzcCwgc3RyZWFtUHJvbWlzZSB9IGZyb20gJy4vYXN5bmMudHMnXG5pbXBvcnQgeyBDb3B5Q29uZGl0aW9ucyB9IGZyb20gJy4vY29weS1jb25kaXRpb25zLnRzJ1xuaW1wb3J0IHsgRXh0ZW5zaW9ucyB9IGZyb20gJy4vZXh0ZW5zaW9ucy50cydcbmltcG9ydCB7XG4gIGNhbGN1bGF0ZUV2ZW5TcGxpdHMsXG4gIGV4dHJhY3RNZXRhZGF0YSxcbiAgZ2V0Q29udGVudExlbmd0aCxcbiAgZ2V0U2NvcGUsXG4gIGdldFNvdXJjZVZlcnNpb25JZCxcbiAgZ2V0VmVyc2lvbklkLFxuICBoYXNoQmluYXJ5LFxuICBpbnNlcnRDb250ZW50VHlwZSxcbiAgaXNBbWF6b25FbmRwb2ludCxcbiAgaXNCb29sZWFuLFxuICBpc0RlZmluZWQsXG4gIGlzRW1wdHksXG4gIGlzTnVtYmVyLFxuICBpc09iamVjdCxcbiAgaXNQbGFpbk9iamVjdCxcbiAgaXNSZWFkYWJsZVN0cmVhbSxcbiAgaXNTdHJpbmcsXG4gIGlzVmFsaWRCdWNrZXROYW1lLFxuICBpc1ZhbGlkRW5kcG9pbnQsXG4gIGlzVmFsaWRPYmplY3ROYW1lLFxuICBpc1ZhbGlkUG9ydCxcbiAgaXNWYWxpZFByZWZpeCxcbiAgaXNWaXJ0dWFsSG9zdFN0eWxlLFxuICBtYWtlRGF0ZUxvbmcsXG4gIFBBUlRfQ09OU1RSQUlOVFMsXG4gIHBhcnRzUmVxdWlyZWQsXG4gIHByZXBlbmRYQU1aTWV0YSxcbiAgcmVhZGFibGVTdHJlYW0sXG4gIHNhbml0aXplRVRhZyxcbiAgdG9NZDUsXG4gIHRvU2hhMjU2LFxuICB1cmlFc2NhcGUsXG4gIHVyaVJlc291cmNlRXNjYXBlLFxufSBmcm9tICcuL2hlbHBlci50cydcbmltcG9ydCB7IGpvaW5Ib3N0UG9ydCB9IGZyb20gJy4vam9pbi1ob3N0LXBvcnQudHMnXG5pbXBvcnQgeyBQb3N0UG9saWN5IH0gZnJvbSAnLi9wb3N0LXBvbGljeS50cydcbmltcG9ydCB7IHJlcXVlc3RXaXRoUmV0cnkgfSBmcm9tICcuL3JlcXVlc3QudHMnXG5pbXBvcnQgeyBkcmFpblJlc3BvbnNlLCByZWFkQXNCdWZmZXIsIHJlYWRBc1N0cmluZyB9IGZyb20gJy4vcmVzcG9uc2UudHMnXG5pbXBvcnQgdHlwZSB7IFJlZ2lvbiB9IGZyb20gJy4vczMtZW5kcG9pbnRzLnRzJ1xuaW1wb3J0IHsgZ2V0UzNFbmRwb2ludCB9IGZyb20gJy4vczMtZW5kcG9pbnRzLnRzJ1xuaW1wb3J0IHR5cGUge1xuICBCaW5hcnksXG4gIEJ1Y2tldEl0ZW1Gcm9tTGlzdCxcbiAgQnVja2V0SXRlbVN0YXQsXG4gIEJ1Y2tldFN0cmVhbSxcbiAgQnVja2V0VmVyc2lvbmluZ0NvbmZpZ3VyYXRpb24sXG4gIENvcHlPYmplY3RQYXJhbXMsXG4gIENvcHlPYmplY3RSZXN1bHQsXG4gIENvcHlPYmplY3RSZXN1bHRWMixcbiAgRW5jcnlwdGlvbkNvbmZpZyxcbiAgR2V0T2JqZWN0TGVnYWxIb2xkT3B0aW9ucyxcbiAgR2V0T2JqZWN0T3B0cyxcbiAgR2V0T2JqZWN0UmV0ZW50aW9uT3B0cyxcbiAgSW5jb21wbGV0ZVVwbG9hZGVkQnVja2V0SXRlbSxcbiAgSVJlcXVlc3QsXG4gIEl0ZW1CdWNrZXRNZXRhZGF0YSxcbiAgTGlmZWN5Y2xlQ29uZmlnLFxuICBMaWZlQ3ljbGVDb25maWdQYXJhbSxcbiAgTGlzdE9iamVjdFF1ZXJ5T3B0cyxcbiAgTGlzdE9iamVjdFF1ZXJ5UmVzLFxuICBPYmplY3RJbmZvLFxuICBPYmplY3RMb2NrQ29uZmlnUGFyYW0sXG4gIE9iamVjdExvY2tJbmZvLFxuICBPYmplY3RNZXRhRGF0YSxcbiAgT2JqZWN0UmV0ZW50aW9uSW5mbyxcbiAgUHJlU2lnblJlcXVlc3RQYXJhbXMsXG4gIFB1dE9iamVjdExlZ2FsSG9sZE9wdGlvbnMsXG4gIFB1dFRhZ2dpbmdQYXJhbXMsXG4gIFJlbW92ZU9iamVjdHNQYXJhbSxcbiAgUmVtb3ZlT2JqZWN0c1JlcXVlc3RFbnRyeSxcbiAgUmVtb3ZlT2JqZWN0c1Jlc3BvbnNlLFxuICBSZW1vdmVUYWdnaW5nUGFyYW1zLFxuICBSZXBsaWNhdGlvbkNvbmZpZyxcbiAgUmVwbGljYXRpb25Db25maWdPcHRzLFxuICBSZXF1ZXN0SGVhZGVycyxcbiAgUmVzcG9uc2VIZWFkZXIsXG4gIFJlc3VsdENhbGxiYWNrLFxuICBSZXRlbnRpb24sXG4gIFNlbGVjdE9wdGlvbnMsXG4gIFN0YXRPYmplY3RPcHRzLFxuICBUYWcsXG4gIFRhZ2dpbmdPcHRzLFxuICBUYWdzLFxuICBUcmFuc3BvcnQsXG4gIFVwbG9hZGVkT2JqZWN0SW5mbyxcbiAgVXBsb2FkUGFydENvbmZpZyxcbn0gZnJvbSAnLi90eXBlLnRzJ1xuaW1wb3J0IHR5cGUgeyBMaXN0TXVsdGlwYXJ0UmVzdWx0LCBVcGxvYWRlZFBhcnQgfSBmcm9tICcuL3htbC1wYXJzZXIudHMnXG5pbXBvcnQge1xuICBwYXJzZUNvbXBsZXRlTXVsdGlwYXJ0LFxuICBwYXJzZUluaXRpYXRlTXVsdGlwYXJ0LFxuICBwYXJzZUxpc3RPYmplY3RzLFxuICBwYXJzZU9iamVjdExlZ2FsSG9sZENvbmZpZyxcbiAgcGFyc2VTZWxlY3RPYmplY3RDb250ZW50UmVzcG9uc2UsXG4gIHVwbG9hZFBhcnRQYXJzZXIsXG59IGZyb20gJy4veG1sLXBhcnNlci50cydcbmltcG9ydCAqIGFzIHhtbFBhcnNlcnMgZnJvbSAnLi94bWwtcGFyc2VyLnRzJ1xuXG5jb25zdCB4bWwgPSBuZXcgeG1sMmpzLkJ1aWxkZXIoeyByZW5kZXJPcHRzOiB7IHByZXR0eTogZmFsc2UgfSwgaGVhZGxlc3M6IHRydWUgfSlcblxuLy8gd2lsbCBiZSByZXBsYWNlZCBieSBidW5kbGVyLlxuY29uc3QgUGFja2FnZSA9IHsgdmVyc2lvbjogcHJvY2Vzcy5lbnYuTUlOSU9fSlNfUEFDS0FHRV9WRVJTSU9OIHx8ICdkZXZlbG9wbWVudCcgfVxuXG5jb25zdCByZXF1ZXN0T3B0aW9uUHJvcGVydGllcyA9IFtcbiAgJ2FnZW50JyxcbiAgJ2NhJyxcbiAgJ2NlcnQnLFxuICAnY2lwaGVycycsXG4gICdjbGllbnRDZXJ0RW5naW5lJyxcbiAgJ2NybCcsXG4gICdkaHBhcmFtJyxcbiAgJ2VjZGhDdXJ2ZScsXG4gICdmYW1pbHknLFxuICAnaG9ub3JDaXBoZXJPcmRlcicsXG4gICdrZXknLFxuICAncGFzc3BocmFzZScsXG4gICdwZngnLFxuICAncmVqZWN0VW5hdXRob3JpemVkJyxcbiAgJ3NlY3VyZU9wdGlvbnMnLFxuICAnc2VjdXJlUHJvdG9jb2wnLFxuICAnc2VydmVybmFtZScsXG4gICdzZXNzaW9uSWRDb250ZXh0Jyxcbl0gYXMgY29uc3RcblxuZXhwb3J0IGludGVyZmFjZSBDbGllbnRPcHRpb25zIHtcbiAgZW5kUG9pbnQ6IHN0cmluZ1xuICBhY2Nlc3NLZXk/OiBzdHJpbmdcbiAgc2VjcmV0S2V5Pzogc3RyaW5nXG4gIHVzZVNTTD86IGJvb2xlYW5cbiAgcG9ydD86IG51bWJlclxuICByZWdpb24/OiBSZWdpb25cbiAgdHJhbnNwb3J0PzogVHJhbnNwb3J0XG4gIHNlc3Npb25Ub2tlbj86IHN0cmluZ1xuICBwYXJ0U2l6ZT86IG51bWJlclxuICBwYXRoU3R5bGU/OiBib29sZWFuXG4gIGNyZWRlbnRpYWxzUHJvdmlkZXI/OiBDcmVkZW50aWFsUHJvdmlkZXJcbiAgczNBY2NlbGVyYXRlRW5kcG9pbnQ/OiBzdHJpbmdcbiAgdHJhbnNwb3J0QWdlbnQ/OiBodHRwLkFnZW50XG59XG5cbmV4cG9ydCB0eXBlIFJlcXVlc3RPcHRpb24gPSBQYXJ0aWFsPElSZXF1ZXN0PiAmIHtcbiAgbWV0aG9kOiBzdHJpbmdcbiAgYnVja2V0TmFtZT86IHN0cmluZ1xuICBvYmplY3ROYW1lPzogc3RyaW5nXG4gIHF1ZXJ5Pzogc3RyaW5nXG4gIHBhdGhTdHlsZT86IGJvb2xlYW5cbn1cblxuZXhwb3J0IHR5cGUgTm9SZXN1bHRDYWxsYmFjayA9IChlcnJvcjogdW5rbm93bikgPT4gdm9pZFxuXG5leHBvcnQgaW50ZXJmYWNlIE1ha2VCdWNrZXRPcHQge1xuICBPYmplY3RMb2NraW5nPzogYm9vbGVhblxufVxuXG5leHBvcnQgaW50ZXJmYWNlIFJlbW92ZU9wdGlvbnMge1xuICB2ZXJzaW9uSWQ/OiBzdHJpbmdcbiAgZ292ZXJuYW5jZUJ5cGFzcz86IGJvb2xlYW5cbiAgZm9yY2VEZWxldGU/OiBib29sZWFuXG59XG5cbnR5cGUgUGFydCA9IHtcbiAgcGFydDogbnVtYmVyXG4gIGV0YWc6IHN0cmluZ1xufVxuXG5leHBvcnQgY2xhc3MgVHlwZWRDbGllbnQge1xuICBwcm90ZWN0ZWQgdHJhbnNwb3J0OiBUcmFuc3BvcnRcbiAgcHJvdGVjdGVkIGhvc3Q6IHN0cmluZ1xuICBwcm90ZWN0ZWQgcG9ydDogbnVtYmVyXG4gIHByb3RlY3RlZCBwcm90b2NvbDogc3RyaW5nXG4gIHByb3RlY3RlZCBhY2Nlc3NLZXk6IHN0cmluZ1xuICBwcm90ZWN0ZWQgc2VjcmV0S2V5OiBzdHJpbmdcbiAgcHJvdGVjdGVkIHNlc3Npb25Ub2tlbj86IHN0cmluZ1xuICBwcm90ZWN0ZWQgdXNlckFnZW50OiBzdHJpbmdcbiAgcHJvdGVjdGVkIGFub255bW91czogYm9vbGVhblxuICBwcm90ZWN0ZWQgcGF0aFN0eWxlOiBib29sZWFuXG4gIHByb3RlY3RlZCByZWdpb25NYXA6IFJlY29yZDxzdHJpbmcsIHN0cmluZz5cbiAgcHVibGljIHJlZ2lvbj86IHN0cmluZ1xuICBwcm90ZWN0ZWQgY3JlZGVudGlhbHNQcm92aWRlcj86IENyZWRlbnRpYWxQcm92aWRlclxuICBwYXJ0U2l6ZTogbnVtYmVyID0gNjQgKiAxMDI0ICogMTAyNFxuICBwcm90ZWN0ZWQgb3ZlclJpZGVQYXJ0U2l6ZT86IGJvb2xlYW5cblxuICBwcm90ZWN0ZWQgbWF4aW11bVBhcnRTaXplID0gNSAqIDEwMjQgKiAxMDI0ICogMTAyNFxuICBwcm90ZWN0ZWQgbWF4T2JqZWN0U2l6ZSA9IDUgKiAxMDI0ICogMTAyNCAqIDEwMjQgKiAxMDI0XG4gIHB1YmxpYyBlbmFibGVTSEEyNTY6IGJvb2xlYW5cbiAgcHJvdGVjdGVkIHMzQWNjZWxlcmF0ZUVuZHBvaW50Pzogc3RyaW5nXG4gIHByb3RlY3RlZCByZXFPcHRpb25zOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPlxuXG4gIHByb3RlY3RlZCB0cmFuc3BvcnRBZ2VudDogaHR0cC5BZ2VudFxuICBwcml2YXRlIHJlYWRvbmx5IGNsaWVudEV4dGVuc2lvbnM6IEV4dGVuc2lvbnNcblxuICBjb25zdHJ1Y3RvcihwYXJhbXM6IENsaWVudE9wdGlvbnMpIHtcbiAgICAvLyBAdHMtZXhwZWN0LWVycm9yIGRlcHJlY2F0ZWQgcHJvcGVydHlcbiAgICBpZiAocGFyYW1zLnNlY3VyZSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoJ1wic2VjdXJlXCIgb3B0aW9uIGRlcHJlY2F0ZWQsIFwidXNlU1NMXCIgc2hvdWxkIGJlIHVzZWQgaW5zdGVhZCcpXG4gICAgfVxuICAgIC8vIERlZmF1bHQgdmFsdWVzIGlmIG5vdCBzcGVjaWZpZWQuXG4gICAgaWYgKHBhcmFtcy51c2VTU0wgPT09IHVuZGVmaW5lZCkge1xuICAgICAgcGFyYW1zLnVzZVNTTCA9IHRydWVcbiAgICB9XG4gICAgaWYgKCFwYXJhbXMucG9ydCkge1xuICAgICAgcGFyYW1zLnBvcnQgPSAwXG4gICAgfVxuICAgIC8vIFZhbGlkYXRlIGlucHV0IHBhcmFtcy5cbiAgICBpZiAoIWlzVmFsaWRFbmRwb2ludChwYXJhbXMuZW5kUG9pbnQpKSB7XG4gICAgICB0aHJvdyBuZXcgZXJyb3JzLkludmFsaWRFbmRwb2ludEVycm9yKGBJbnZhbGlkIGVuZFBvaW50IDogJHtwYXJhbXMuZW5kUG9pbnR9YClcbiAgICB9XG4gICAgaWYgKCFpc1ZhbGlkUG9ydChwYXJhbXMucG9ydCkpIHtcbiAgICAgIHRocm93IG5ldyBlcnJvcnMuSW52YWxpZEFyZ3VtZW50RXJyb3IoYEludmFsaWQgcG9ydCA6ICR7cGFyYW1zLnBvcnR9YClcbiAgICB9XG4gICAgaWYgKCFpc0Jvb2xlYW4ocGFyYW1zLnVzZVNTTCkpIHtcbiAgICAgIHRocm93IG5ldyBlcnJvcnMuSW52YWxpZEFyZ3VtZW50RXJyb3IoXG4gICAgICAgIGBJbnZhbGlkIHVzZVNTTCBmbGFnIHR5cGUgOiAke3BhcmFtcy51c2VTU0x9LCBleHBlY3RlZCB0byBiZSBvZiB0eXBlIFwiYm9vbGVhblwiYCxcbiAgICAgIClcbiAgICB9XG5cbiAgICAvLyBWYWxpZGF0ZSByZWdpb24gb25seSBpZiBpdHMgc2V0LlxuICAgIGlmIChwYXJhbXMucmVnaW9uKSB7XG4gICAgICBpZiAoIWlzU3RyaW5nKHBhcmFtcy5yZWdpb24pKSB7XG4gICAgICAgIHRocm93IG5ldyBlcnJvcnMuSW52YWxpZEFyZ3VtZW50RXJyb3IoYEludmFsaWQgcmVnaW9uIDogJHtwYXJhbXMucmVnaW9ufWApXG4gICAgICB9XG4gICAgfVxuXG4gICAgY29uc3QgaG9zdCA9IHBhcmFtcy5lbmRQb2ludC50b0xvd2VyQ2FzZSgpXG4gICAgbGV0IHBvcnQgPSBwYXJhbXMucG9ydFxuICAgIGxldCBwcm90b2NvbDogc3RyaW5nXG4gICAgbGV0IHRyYW5zcG9ydFxuICAgIGxldCB0cmFuc3BvcnRBZ2VudDogaHR0cC5BZ2VudFxuICAgIC8vIFZhbGlkYXRlIGlmIGNvbmZpZ3VyYXRpb24gaXMgbm90IHVzaW5nIFNTTFxuICAgIC8vIGZvciBjb25zdHJ1Y3RpbmcgcmVsZXZhbnQgZW5kcG9pbnRzLlxuICAgIGlmIChwYXJhbXMudXNlU1NMKSB7XG4gICAgICAvLyBEZWZhdWx0cyB0byBzZWN1cmUuXG4gICAgICB0cmFuc3BvcnQgPSBodHRwc1xuICAgICAgcHJvdG9jb2wgPSAnaHR0cHM6J1xuICAgICAgcG9ydCA9IHBvcnQgfHwgNDQzXG4gICAgICB0cmFuc3BvcnRBZ2VudCA9IGh0dHBzLmdsb2JhbEFnZW50XG4gICAgfSBlbHNlIHtcbiAgICAgIHRyYW5zcG9ydCA9IGh0dHBcbiAgICAgIHByb3RvY29sID0gJ2h0dHA6J1xuICAgICAgcG9ydCA9IHBvcnQgfHwgODBcbiAgICAgIHRyYW5zcG9ydEFnZW50ID0gaHR0cC5nbG9iYWxBZ2VudFxuICAgIH1cblxuICAgIC8vIGlmIGN1c3RvbSB0cmFuc3BvcnQgaXMgc2V0LCB1c2UgaXQuXG4gICAgaWYgKHBhcmFtcy50cmFuc3BvcnQpIHtcbiAgICAgIGlmICghaXNPYmplY3QocGFyYW1zLnRyYW5zcG9ydCkpIHtcbiAgICAgICAgdGhyb3cgbmV3IGVycm9ycy5JbnZhbGlkQXJndW1lbnRFcnJvcihcbiAgICAgICAgICBgSW52YWxpZCB0cmFuc3BvcnQgdHlwZSA6ICR7cGFyYW1zLnRyYW5zcG9ydH0sIGV4cGVjdGVkIHRvIGJlIHR5cGUgXCJvYmplY3RcImAsXG4gICAgICAgIClcbiAgICAgIH1cbiAgICAgIHRyYW5zcG9ydCA9IHBhcmFtcy50cmFuc3BvcnRcbiAgICB9XG5cbiAgICAvLyBpZiBjdXN0b20gdHJhbnNwb3J0IGFnZW50IGlzIHNldCwgdXNlIGl0LlxuICAgIGlmIChwYXJhbXMudHJhbnNwb3J0QWdlbnQpIHtcbiAgICAgIGlmICghaXNPYmplY3QocGFyYW1zLnRyYW5zcG9ydEFnZW50KSkge1xuICAgICAgICB0aHJvdyBuZXcgZXJyb3JzLkludmFsaWRBcmd1bWVudEVycm9yKFxuICAgICAgICAgIGBJbnZhbGlkIHRyYW5zcG9ydEFnZW50IHR5cGU6ICR7cGFyYW1zLnRyYW5zcG9ydEFnZW50fSwgZXhwZWN0ZWQgdG8gYmUgdHlwZSBcIm9iamVjdFwiYCxcbiAgICAgICAgKVxuICAgICAgfVxuXG4gICAgICB0cmFuc3BvcnRBZ2VudCA9IHBhcmFtcy50cmFuc3BvcnRBZ2VudFxuICAgIH1cblxuICAgIC8vIFVzZXIgQWdlbnQgc2hvdWxkIGFsd2F5cyBmb2xsb3dpbmcgdGhlIGJlbG93IHN0eWxlLlxuICAgIC8vIFBsZWFzZSBvcGVuIGFuIGlzc3VlIHRvIGRpc2N1c3MgYW55IG5ldyBjaGFuZ2VzIGhlcmUuXG4gICAgLy9cbiAgICAvLyAgICAgICBNaW5JTyAoT1M7IEFSQ0gpIExJQi9WRVIgQVBQL1ZFUlxuICAgIC8vXG4gICAgY29uc3QgbGlicmFyeUNvbW1lbnRzID0gYCgke3Byb2Nlc3MucGxhdGZvcm19OyAke3Byb2Nlc3MuYXJjaH0pYFxuICAgIGNvbnN0IGxpYnJhcnlBZ2VudCA9IGBNaW5JTyAke2xpYnJhcnlDb21tZW50c30gbWluaW8tanMvJHtQYWNrYWdlLnZlcnNpb259YFxuICAgIC8vIFVzZXIgYWdlbnQgYmxvY2sgZW5kcy5cblxuICAgIHRoaXMudHJhbnNwb3J0ID0gdHJhbnNwb3J0XG4gICAgdGhpcy50cmFuc3BvcnRBZ2VudCA9IHRyYW5zcG9ydEFnZW50XG4gICAgdGhpcy5ob3N0ID0gaG9zdFxuICAgIHRoaXMucG9ydCA9IHBvcnRcbiAgICB0aGlzLnByb3RvY29sID0gcHJvdG9jb2xcbiAgICB0aGlzLnVzZXJBZ2VudCA9IGAke2xpYnJhcnlBZ2VudH1gXG5cbiAgICAvLyBEZWZhdWx0IHBhdGggc3R5bGUgaXMgdHJ1ZVxuICAgIGlmIChwYXJhbXMucGF0aFN0eWxlID09PSB1bmRlZmluZWQpIHtcbiAgICAgIHRoaXMucGF0aFN0eWxlID0gdHJ1ZVxuICAgIH0gZWxzZSB7XG4gICAgICB0aGlzLnBhdGhTdHlsZSA9IHBhcmFtcy5wYXRoU3R5bGVcbiAgICB9XG5cbiAgICB0aGlzLmFjY2Vzc0tleSA9IHBhcmFtcy5hY2Nlc3NLZXkgPz8gJydcbiAgICB0aGlzLnNlY3JldEtleSA9IHBhcmFtcy5zZWNyZXRLZXkgPz8gJydcbiAgICB0aGlzLnNlc3Npb25Ub2tlbiA9IHBhcmFtcy5zZXNzaW9uVG9rZW5cbiAgICB0aGlzLmFub255bW91cyA9ICF0aGlzLmFjY2Vzc0tleSB8fCAhdGhpcy5zZWNyZXRLZXlcblxuICAgIGlmIChwYXJhbXMuY3JlZGVudGlhbHNQcm92aWRlcikge1xuICAgICAgdGhpcy5hbm9ueW1vdXMgPSBmYWxzZVxuICAgICAgdGhpcy5jcmVkZW50aWFsc1Byb3ZpZGVyID0gcGFyYW1zLmNyZWRlbnRpYWxzUHJvdmlkZXJcbiAgICB9XG5cbiAgICB0aGlzLnJlZ2lvbk1hcCA9IHt9XG4gICAgaWYgKHBhcmFtcy5yZWdpb24pIHtcbiAgICAgIHRoaXMucmVnaW9uID0gcGFyYW1zLnJlZ2lvblxuICAgIH1cblxuICAgIGlmIChwYXJhbXMucGFydFNpemUpIHtcbiAgICAgIHRoaXMucGFydFNpemUgPSBwYXJhbXMucGFydFNpemVcbiAgICAgIHRoaXMub3ZlclJpZGVQYXJ0U2l6ZSA9IHRydWVcbiAgICB9XG4gICAgaWYgKHRoaXMucGFydFNpemUgPCA1ICogMTAyNCAqIDEwMjQpIHtcbiAgICAgIHRocm93IG5ldyBlcnJvcnMuSW52YWxpZEFyZ3VtZW50RXJyb3IoYFBhcnQgc2l6ZSBzaG91bGQgYmUgZ3JlYXRlciB0aGFuIDVNQmApXG4gICAgfVxuICAgIGlmICh0aGlzLnBhcnRTaXplID4gNSAqIDEwMjQgKiAxMDI0ICogMTAyNCkge1xuICAgICAgdGhyb3cgbmV3IGVycm9ycy5JbnZhbGlkQXJndW1lbnRFcnJvcihgUGFydCBzaXplIHNob3VsZCBiZSBsZXNzIHRoYW4gNUdCYClcbiAgICB9XG5cbiAgICAvLyBTSEEyNTYgaXMgZW5hYmxlZCBvbmx5IGZvciBhdXRoZW50aWNhdGVkIGh0dHAgcmVxdWVzdHMuIElmIHRoZSByZXF1ZXN0IGlzIGF1dGhlbnRpY2F0ZWRcbiAgICAvLyBhbmQgdGhlIGNvbm5lY3Rpb24gaXMgaHR0cHMgd2UgdXNlIHgtYW16LWNvbnRlbnQtc2hhMjU2PVVOU0lHTkVELVBBWUxPQURcbiAgICAvLyBoZWFkZXIgZm9yIHNpZ25hdHVyZSBjYWxjdWxhdGlvbi5cbiAgICB0aGlzLmVuYWJsZVNIQTI1NiA9ICF0aGlzLmFub255bW91cyAmJiAhcGFyYW1zLnVzZVNTTFxuXG4gICAgdGhpcy5zM0FjY2VsZXJhdGVFbmRwb2ludCA9IHBhcmFtcy5zM0FjY2VsZXJhdGVFbmRwb2ludCB8fCB1bmRlZmluZWRcbiAgICB0aGlzLnJlcU9wdGlvbnMgPSB7fVxuICAgIHRoaXMuY2xpZW50RXh0ZW5zaW9ucyA9IG5ldyBFeHRlbnNpb25zKHRoaXMpXG4gIH1cbiAgLyoqXG4gICAqIE1pbmlvIGV4dGVuc2lvbnMgdGhhdCBhcmVuJ3QgbmVjZXNzYXJ5IHByZXNlbnQgZm9yIEFtYXpvbiBTMyBjb21wYXRpYmxlIHN0b3JhZ2Ugc2VydmVyc1xuICAgKi9cbiAgZ2V0IGV4dGVuc2lvbnMoKSB7XG4gICAgcmV0dXJuIHRoaXMuY2xpZW50RXh0ZW5zaW9uc1xuICB9XG5cbiAgLyoqXG4gICAqIEBwYXJhbSBlbmRQb2ludCAtIHZhbGlkIFMzIGFjY2VsZXJhdGlvbiBlbmQgcG9pbnRcbiAgICovXG4gIHNldFMzVHJhbnNmZXJBY2NlbGVyYXRlKGVuZFBvaW50OiBzdHJpbmcpIHtcbiAgICB0aGlzLnMzQWNjZWxlcmF0ZUVuZHBvaW50ID0gZW5kUG9pbnRcbiAgfVxuXG4gIC8qKlxuICAgKiBTZXRzIHRoZSBzdXBwb3J0ZWQgcmVxdWVzdCBvcHRpb25zLlxuICAgKi9cbiAgcHVibGljIHNldFJlcXVlc3RPcHRpb25zKG9wdGlvbnM6IFBpY2s8aHR0cHMuUmVxdWVzdE9wdGlvbnMsICh0eXBlb2YgcmVxdWVzdE9wdGlvblByb3BlcnRpZXMpW251bWJlcl0+KSB7XG4gICAgaWYgKCFpc09iamVjdChvcHRpb25zKSkge1xuICAgICAgdGhyb3cgbmV3IFR5cGVFcnJvcigncmVxdWVzdCBvcHRpb25zIHNob3VsZCBiZSBvZiB0eXBlIFwib2JqZWN0XCInKVxuICAgIH1cbiAgICB0aGlzLnJlcU9wdGlvbnMgPSBfLnBpY2sob3B0aW9ucywgcmVxdWVzdE9wdGlvblByb3BlcnRpZXMpXG4gIH1cblxuICAvKipcbiAgICogIFRoaXMgaXMgczMgU3BlY2lmaWMgYW5kIGRvZXMgbm90IGhvbGQgdmFsaWRpdHkgaW4gYW55IG90aGVyIE9iamVjdCBzdG9yYWdlLlxuICAgKi9cbiAgcHJpdmF0ZSBnZXRBY2NlbGVyYXRlRW5kUG9pbnRJZlNldChidWNrZXROYW1lPzogc3RyaW5nLCBvYmplY3ROYW1lPzogc3RyaW5nKSB7XG4gICAgaWYgKCFpc0VtcHR5KHRoaXMuczNBY2NlbGVyYXRlRW5kcG9pbnQpICYmICFpc0VtcHR5KGJ1Y2tldE5hbWUpICYmICFpc0VtcHR5KG9iamVjdE5hbWUpKSB7XG4gICAgICAvLyBodHRwOi8vZG9jcy5hd3MuYW1hem9uLmNvbS9BbWF6b25TMy9sYXRlc3QvZGV2L3RyYW5zZmVyLWFjY2VsZXJhdGlvbi5odG1sXG4gICAgICAvLyBEaXNhYmxlIHRyYW5zZmVyIGFjY2VsZXJhdGlvbiBmb3Igbm9uLWNvbXBsaWFudCBidWNrZXQgbmFtZXMuXG4gICAgICBpZiAoYnVja2V0TmFtZS5pbmNsdWRlcygnLicpKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihgVHJhbnNmZXIgQWNjZWxlcmF0aW9uIGlzIG5vdCBzdXBwb3J0ZWQgZm9yIG5vbiBjb21wbGlhbnQgYnVja2V0OiR7YnVja2V0TmFtZX1gKVxuICAgICAgfVxuICAgICAgLy8gSWYgdHJhbnNmZXIgYWNjZWxlcmF0aW9uIGlzIHJlcXVlc3RlZCBzZXQgbmV3IGhvc3QuXG4gICAgICAvLyBGb3IgbW9yZSBkZXRhaWxzIGFib3V0IGVuYWJsaW5nIHRyYW5zZmVyIGFjY2VsZXJhdGlvbiByZWFkIGhlcmUuXG4gICAgICAvLyBodHRwOi8vZG9jcy5hd3MuYW1hem9uLmNvbS9BbWF6b25TMy9sYXRlc3QvZGV2L3RyYW5zZmVyLWFjY2VsZXJhdGlvbi5odG1sXG4gICAgICByZXR1cm4gdGhpcy5zM0FjY2VsZXJhdGVFbmRwb2ludFxuICAgIH1cbiAgICByZXR1cm4gZmFsc2VcbiAgfVxuXG4gIC8qKlxuICAgKiAgIFNldCBhcHBsaWNhdGlvbiBzcGVjaWZpYyBpbmZvcm1hdGlvbi5cbiAgICogICBHZW5lcmF0ZXMgVXNlci1BZ2VudCBpbiB0aGUgZm9sbG93aW5nIHN0eWxlLlxuICAgKiAgIE1pbklPIChPUzsgQVJDSCkgTElCL1ZFUiBBUFAvVkVSXG4gICAqL1xuICBzZXRBcHBJbmZvKGFwcE5hbWU6IHN0cmluZywgYXBwVmVyc2lvbjogc3RyaW5nKSB7XG4gICAgaWYgKCFpc1N0cmluZyhhcHBOYW1lKSkge1xuICAgICAgdGhyb3cgbmV3IFR5cGVFcnJvcihgSW52YWxpZCBhcHBOYW1lOiAke2FwcE5hbWV9YClcbiAgICB9XG4gICAgaWYgKGFwcE5hbWUudHJpbSgpID09PSAnJykge1xuICAgICAgdGhyb3cgbmV3IGVycm9ycy5JbnZhbGlkQXJndW1lbnRFcnJvcignSW5wdXQgYXBwTmFtZSBjYW5ub3QgYmUgZW1wdHkuJylcbiAgICB9XG4gICAgaWYgKCFpc1N0cmluZyhhcHBWZXJzaW9uKSkge1xuICAgICAgdGhyb3cgbmV3IFR5cGVFcnJvcihgSW52YWxpZCBhcHBWZXJzaW9uOiAke2FwcFZlcnNpb259YClcbiAgICB9XG4gICAgaWYgKGFwcFZlcnNpb24udHJpbSgpID09PSAnJykge1xuICAgICAgdGhyb3cgbmV3IGVycm9ycy5JbnZhbGlkQXJndW1lbnRFcnJvcignSW5wdXQgYXBwVmVyc2lvbiBjYW5ub3QgYmUgZW1wdHkuJylcbiAgICB9XG4gICAgdGhpcy51c2VyQWdlbnQgPSBgJHt0aGlzLnVzZXJBZ2VudH0gJHthcHBOYW1lfS8ke2FwcFZlcnNpb259YFxuICB9XG5cbiAgLyoqXG4gICAqIHJldHVybnMgb3B0aW9ucyBvYmplY3QgdGhhdCBjYW4gYmUgdXNlZCB3aXRoIGh0dHAucmVxdWVzdCgpXG4gICAqIFRha2VzIGNhcmUgb2YgY29uc3RydWN0aW5nIHZpcnR1YWwtaG9zdC1zdHlsZSBvciBwYXRoLXN0eWxlIGhvc3RuYW1lXG4gICAqL1xuICBwcm90ZWN0ZWQgZ2V0UmVxdWVzdE9wdGlvbnMoXG4gICAgb3B0czogUmVxdWVzdE9wdGlvbiAmIHtcbiAgICAgIHJlZ2lvbjogc3RyaW5nXG4gICAgfSxcbiAgKTogSVJlcXVlc3QgJiB7XG4gICAgaG9zdDogc3RyaW5nXG4gICAgaGVhZGVyczogUmVjb3JkPHN0cmluZywgc3RyaW5nPlxuICB9IHtcbiAgICBjb25zdCBtZXRob2QgPSBvcHRzLm1ldGhvZFxuICAgIGNvbnN0IHJlZ2lvbiA9IG9wdHMucmVnaW9uXG4gICAgY29uc3QgYnVja2V0TmFtZSA9IG9wdHMuYnVja2V0TmFtZVxuICAgIGxldCBvYmplY3ROYW1lID0gb3B0cy5vYmplY3ROYW1lXG4gICAgY29uc3QgaGVhZGVycyA9IG9wdHMuaGVhZGVyc1xuICAgIGNvbnN0IHF1ZXJ5ID0gb3B0cy5xdWVyeVxuXG4gICAgbGV0IHJlcU9wdGlvbnMgPSB7XG4gICAgICBtZXRob2QsXG4gICAgICBoZWFkZXJzOiB7fSBhcyBSZXF1ZXN0SGVhZGVycyxcbiAgICAgIHByb3RvY29sOiB0aGlzLnByb3RvY29sLFxuICAgICAgLy8gSWYgY3VzdG9tIHRyYW5zcG9ydEFnZW50IHdhcyBzdXBwbGllZCBlYXJsaWVyLCB3ZSdsbCBpbmplY3QgaXQgaGVyZVxuICAgICAgYWdlbnQ6IHRoaXMudHJhbnNwb3J0QWdlbnQsXG4gICAgfVxuXG4gICAgLy8gVmVyaWZ5IGlmIHZpcnR1YWwgaG9zdCBzdXBwb3J0ZWQuXG4gICAgbGV0IHZpcnR1YWxIb3N0U3R5bGVcbiAgICBpZiAoYnVja2V0TmFtZSkge1xuICAgICAgdmlydHVhbEhvc3RTdHlsZSA9IGlzVmlydHVhbEhvc3RTdHlsZSh0aGlzLmhvc3QsIHRoaXMucHJvdG9jb2wsIGJ1Y2tldE5hbWUsIHRoaXMucGF0aFN0eWxlKVxuICAgIH1cblxuICAgIGxldCBwYXRoID0gJy8nXG4gICAgbGV0IGhvc3QgPSB0aGlzLmhvc3RcblxuICAgIGxldCBwb3J0OiB1bmRlZmluZWQgfCBudW1iZXJcbiAgICBpZiAodGhpcy5wb3J0KSB7XG4gICAgICBwb3J0ID0gdGhpcy5wb3J0XG4gICAgfVxuXG4gICAgaWYgKG9iamVjdE5hbWUpIHtcbiAgICAgIG9iamVjdE5hbWUgPSB1cmlSZXNvdXJjZUVzY2FwZShvYmplY3ROYW1lKVxuICAgIH1cblxuICAgIC8vIEZvciBBbWF6b24gUzMgZW5kcG9pbnQsIGdldCBlbmRwb2ludCBiYXNlZCBvbiByZWdpb24uXG4gICAgaWYgKGlzQW1hem9uRW5kcG9pbnQoaG9zdCkpIHtcbiAgICAgIGNvbnN0IGFjY2VsZXJhdGVFbmRQb2ludCA9IHRoaXMuZ2V0QWNjZWxlcmF0ZUVuZFBvaW50SWZTZXQoYnVja2V0TmFtZSwgb2JqZWN0TmFtZSlcbiAgICAgIGlmIChhY2NlbGVyYXRlRW5kUG9pbnQpIHtcbiAgICAgICAgaG9zdCA9IGAke2FjY2VsZXJhdGVFbmRQb2ludH1gXG4gICAgICB9IGVsc2Uge1xuICAgICAgICBob3N0ID0gZ2V0UzNFbmRwb2ludChyZWdpb24pXG4gICAgICB9XG4gICAgfVxuXG4gICAgaWYgKHZpcnR1YWxIb3N0U3R5bGUgJiYgIW9wdHMucGF0aFN0eWxlKSB7XG4gICAgICAvLyBGb3IgYWxsIGhvc3RzIHdoaWNoIHN1cHBvcnQgdmlydHVhbCBob3N0IHN0eWxlLCBgYnVja2V0TmFtZWBcbiAgICAgIC8vIGlzIHBhcnQgb2YgdGhlIGhvc3RuYW1lIGluIHRoZSBmb2xsb3dpbmcgZm9ybWF0OlxuICAgICAgLy9cbiAgICAgIC8vICB2YXIgaG9zdCA9ICdidWNrZXROYW1lLmV4YW1wbGUuY29tJ1xuICAgICAgLy9cbiAgICAgIGlmIChidWNrZXROYW1lKSB7XG4gICAgICAgIGhvc3QgPSBgJHtidWNrZXROYW1lfS4ke2hvc3R9YFxuICAgICAgfVxuICAgICAgaWYgKG9iamVjdE5hbWUpIHtcbiAgICAgICAgcGF0aCA9IGAvJHtvYmplY3ROYW1lfWBcbiAgICAgIH1cbiAgICB9IGVsc2Uge1xuICAgICAgLy8gRm9yIGFsbCBTMyBjb21wYXRpYmxlIHN0b3JhZ2Ugc2VydmljZXMgd2Ugd2lsbCBmYWxsYmFjayB0b1xuICAgICAgLy8gcGF0aCBzdHlsZSByZXF1ZXN0cywgd2hlcmUgYGJ1Y2tldE5hbWVgIGlzIHBhcnQgb2YgdGhlIFVSSVxuICAgICAgLy8gcGF0aC5cbiAgICAgIGlmIChidWNrZXROYW1lKSB7XG4gICAgICAgIHBhdGggPSBgLyR7YnVja2V0TmFtZX1gXG4gICAgICB9XG4gICAgICBpZiAob2JqZWN0TmFtZSkge1xuICAgICAgICBwYXRoID0gYC8ke2J1Y2tldE5hbWV9LyR7b2JqZWN0TmFtZX1gXG4gICAgICB9XG4gICAgfVxuXG4gICAgaWYgKHF1ZXJ5KSB7XG4gICAgICBwYXRoICs9IGA/JHtxdWVyeX1gXG4gICAgfVxuICAgIHJlcU9wdGlvbnMuaGVhZGVycy5ob3N0ID0gaG9zdFxuICAgIGlmICgocmVxT3B0aW9ucy5wcm90b2NvbCA9PT0gJ2h0dHA6JyAmJiBwb3J0ICE9PSA4MCkgfHwgKHJlcU9wdGlvbnMucHJvdG9jb2wgPT09ICdodHRwczonICYmIHBvcnQgIT09IDQ0MykpIHtcbiAgICAgIHJlcU9wdGlvbnMuaGVhZGVycy5ob3N0ID0gam9pbkhvc3RQb3J0KGhvc3QsIHBvcnQpXG4gICAgfVxuXG4gICAgcmVxT3B0aW9ucy5oZWFkZXJzWyd1c2VyLWFnZW50J10gPSB0aGlzLnVzZXJBZ2VudFxuICAgIGlmIChoZWFkZXJzKSB7XG4gICAgICAvLyBoYXZlIGFsbCBoZWFkZXIga2V5cyBpbiBsb3dlciBjYXNlIC0gdG8gbWFrZSBzaWduaW5nIGVhc3lcbiAgICAgIGZvciAoY29uc3QgW2ssIHZdIG9mIE9iamVjdC5lbnRyaWVzKGhlYWRlcnMpKSB7XG4gICAgICAgIHJlcU9wdGlvbnMuaGVhZGVyc1trLnRvTG93ZXJDYXNlKCldID0gdlxuICAgICAgfVxuICAgIH1cblxuICAgIC8vIFVzZSBhbnkgcmVxdWVzdCBvcHRpb24gc3BlY2lmaWVkIGluIG1pbmlvQ2xpZW50LnNldFJlcXVlc3RPcHRpb25zKClcbiAgICByZXFPcHRpb25zID0gT2JqZWN0LmFzc2lnbih7fSwgdGhpcy5yZXFPcHRpb25zLCByZXFPcHRpb25zKVxuXG4gICAgcmV0dXJuIHtcbiAgICAgIC4uLnJlcU9wdGlvbnMsXG4gICAgICBoZWFkZXJzOiBfLm1hcFZhbHVlcyhfLnBpY2tCeShyZXFPcHRpb25zLmhlYWRlcnMsIGlzRGVmaW5lZCksICh2KSA9PiB2LnRvU3RyaW5nKCkpLFxuICAgICAgaG9zdCxcbiAgICAgIHBvcnQsXG4gICAgICBwYXRoLFxuICAgIH0gc2F0aXNmaWVzIGh0dHBzLlJlcXVlc3RPcHRpb25zXG4gIH1cblxuICBwdWJsaWMgYXN5bmMgc2V0Q3JlZGVudGlhbHNQcm92aWRlcihjcmVkZW50aWFsc1Byb3ZpZGVyOiBDcmVkZW50aWFsUHJvdmlkZXIpIHtcbiAgICBpZiAoIShjcmVkZW50aWFsc1Byb3ZpZGVyIGluc3RhbmNlb2YgQ3JlZGVudGlhbFByb3ZpZGVyKSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKCdVbmFibGUgdG8gZ2V0IGNyZWRlbnRpYWxzLiBFeHBlY3RlZCBpbnN0YW5jZSBvZiBDcmVkZW50aWFsUHJvdmlkZXInKVxuICAgIH1cbiAgICB0aGlzLmNyZWRlbnRpYWxzUHJvdmlkZXIgPSBjcmVkZW50aWFsc1Byb3ZpZGVyXG4gICAgYXdhaXQgdGhpcy5jaGVja0FuZFJlZnJlc2hDcmVkcygpXG4gIH1cblxuICBwcml2YXRlIGFzeW5jIGNoZWNrQW5kUmVmcmVzaENyZWRzKCkge1xuICAgIGlmICh0aGlzLmNyZWRlbnRpYWxzUHJvdmlkZXIpIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IGNyZWRlbnRpYWxzQ29uZiA9IGF3YWl0IHRoaXMuY3JlZGVudGlhbHNQcm92aWRlci5nZXRDcmVkZW50aWFscygpXG4gICAgICAgIHRoaXMuYWNjZXNzS2V5ID0gY3JlZGVudGlhbHNDb25mLmdldEFjY2Vzc0tleSgpXG4gICAgICAgIHRoaXMuc2VjcmV0S2V5ID0gY3JlZGVudGlhbHNDb25mLmdldFNlY3JldEtleSgpXG4gICAgICAgIHRoaXMuc2Vzc2lvblRva2VuID0gY3JlZGVudGlhbHNDb25mLmdldFNlc3Npb25Ub2tlbigpXG4gICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihgVW5hYmxlIHRvIGdldCBjcmVkZW50aWFsczogJHtlfWAsIHsgY2F1c2U6IGUgfSlcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICBwcml2YXRlIGxvZ1N0cmVhbT86IHN0cmVhbS5Xcml0YWJsZVxuXG4gIC8qKlxuICAgKiBsb2cgdGhlIHJlcXVlc3QsIHJlc3BvbnNlLCBlcnJvclxuICAgKi9cbiAgcHJpdmF0ZSBsb2dIVFRQKHJlcU9wdGlvbnM6IElSZXF1ZXN0LCByZXNwb25zZTogaHR0cC5JbmNvbWluZ01lc3NhZ2UgfCBudWxsLCBlcnI/OiB1bmtub3duKSB7XG4gICAgLy8gaWYgbm8gbG9nU3RyZWFtIGF2YWlsYWJsZSByZXR1cm4uXG4gICAgaWYgKCF0aGlzLmxvZ1N0cmVhbSkge1xuICAgICAgcmV0dXJuXG4gICAgfVxuICAgIGlmICghaXNPYmplY3QocmVxT3B0aW9ucykpIHtcbiAgICAgIHRocm93IG5ldyBUeXBlRXJyb3IoJ3JlcU9wdGlvbnMgc2hvdWxkIGJlIG9mIHR5cGUgXCJvYmplY3RcIicpXG4gICAgfVxuICAgIGlmIChyZXNwb25zZSAmJiAhaXNSZWFkYWJsZVN0cmVhbShyZXNwb25zZSkpIHtcbiAgICAgIHRocm93IG5ldyBUeXBlRXJyb3IoJ3Jlc3BvbnNlIHNob3VsZCBiZSBvZiB0eXBlIFwiU3RyZWFtXCInKVxuICAgIH1cbiAgICBpZiAoZXJyICYmICEoZXJyIGluc3RhbmNlb2YgRXJyb3IpKSB7XG4gICAgICB0aHJvdyBuZXcgVHlwZUVycm9yKCdlcnIgc2hvdWxkIGJlIG9mIHR5cGUgXCJFcnJvclwiJylcbiAgICB9XG4gICAgY29uc3QgbG9nU3RyZWFtID0gdGhpcy5sb2dTdHJlYW1cbiAgICBjb25zdCBsb2dIZWFkZXJzID0gKGhlYWRlcnM6IFJlcXVlc3RIZWFkZXJzKSA9PiB7XG4gICAgICBPYmplY3QuZW50cmllcyhoZWFkZXJzKS5mb3JFYWNoKChbaywgdl0pID0+IHtcbiAgICAgICAgaWYgKGsgPT0gJ2F1dGhvcml6YXRpb24nKSB7XG4gICAgICAgICAgaWYgKGlzU3RyaW5nKHYpKSB7XG4gICAgICAgICAgICBjb25zdCByZWRhY3RvciA9IG5ldyBSZWdFeHAoJ1NpZ25hdHVyZT0oWzAtOWEtZl0rKScpXG4gICAgICAgICAgICB2ID0gdi5yZXBsYWNlKHJlZGFjdG9yLCAnU2lnbmF0dXJlPSoqUkVEQUNURUQqKicpXG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICAgIGxvZ1N0cmVhbS53cml0ZShgJHtrfTogJHt2fVxcbmApXG4gICAgICB9KVxuICAgICAgbG9nU3RyZWFtLndyaXRlKCdcXG4nKVxuICAgIH1cbiAgICBsb2dTdHJlYW0ud3JpdGUoYFJFUVVFU1Q6ICR7cmVxT3B0aW9ucy5tZXRob2R9ICR7cmVxT3B0aW9ucy5wYXRofVxcbmApXG4gICAgbG9nSGVhZGVycyhyZXFPcHRpb25zLmhlYWRlcnMpXG4gICAgaWYgKHJlc3BvbnNlKSB7XG4gICAgICB0aGlzLmxvZ1N0cmVhbS53cml0ZShgUkVTUE9OU0U6ICR7cmVzcG9uc2Uuc3RhdHVzQ29kZX1cXG5gKVxuICAgICAgbG9nSGVhZGVycyhyZXNwb25zZS5oZWFkZXJzIGFzIFJlcXVlc3RIZWFkZXJzKVxuICAgIH1cbiAgICBpZiAoZXJyKSB7XG4gICAgICBsb2dTdHJlYW0ud3JpdGUoJ0VSUk9SIEJPRFk6XFxuJylcbiAgICAgIGNvbnN0IGVyckpTT04gPSBKU09OLnN0cmluZ2lmeShlcnIsIG51bGwsICdcXHQnKVxuICAgICAgbG9nU3RyZWFtLndyaXRlKGAke2VyckpTT059XFxuYClcbiAgICB9XG4gIH1cblxuICAvKipcbiAgICogRW5hYmxlIHRyYWNpbmdcbiAgICovXG4gIHB1YmxpYyB0cmFjZU9uKHN0cmVhbT86IHN0cmVhbS5Xcml0YWJsZSkge1xuICAgIGlmICghc3RyZWFtKSB7XG4gICAgICBzdHJlYW0gPSBwcm9jZXNzLnN0ZG91dFxuICAgIH1cbiAgICB0aGlzLmxvZ1N0cmVhbSA9IHN0cmVhbVxuICB9XG5cbiAgLyoqXG4gICAqIERpc2FibGUgdHJhY2luZ1xuICAgKi9cbiAgcHVibGljIHRyYWNlT2ZmKCkge1xuICAgIHRoaXMubG9nU3RyZWFtID0gdW5kZWZpbmVkXG4gIH1cblxuICAvKipcbiAgICogbWFrZVJlcXVlc3QgaXMgdGhlIHByaW1pdGl2ZSB1c2VkIGJ5IHRoZSBhcGlzIGZvciBtYWtpbmcgUzMgcmVxdWVzdHMuXG4gICAqIHBheWxvYWQgY2FuIGJlIGVtcHR5IHN0cmluZyBpbiBjYXNlIG9mIG5vIHBheWxvYWQuXG4gICAqIHN0YXR1c0NvZGUgaXMgdGhlIGV4cGVjdGVkIHN0YXR1c0NvZGUuIElmIHJlc3BvbnNlLnN0YXR1c0NvZGUgZG9lcyBub3QgbWF0Y2hcbiAgICogd2UgcGFyc2UgdGhlIFhNTCBlcnJvciBhbmQgY2FsbCB0aGUgY2FsbGJhY2sgd2l0aCB0aGUgZXJyb3IgbWVzc2FnZS5cbiAgICpcbiAgICogQSB2YWxpZCByZWdpb24gaXMgcGFzc2VkIGJ5IHRoZSBjYWxscyAtIGxpc3RCdWNrZXRzLCBtYWtlQnVja2V0IGFuZCBnZXRCdWNrZXRSZWdpb24uXG4gICAqXG4gICAqIEBpbnRlcm5hbFxuICAgKi9cbiAgYXN5bmMgbWFrZVJlcXVlc3RBc3luYyhcbiAgICBvcHRpb25zOiBSZXF1ZXN0T3B0aW9uLFxuICAgIHBheWxvYWQ6IEJpbmFyeSA9ICcnLFxuICAgIGV4cGVjdGVkQ29kZXM6IG51bWJlcltdID0gWzIwMF0sXG4gICAgcmVnaW9uID0gJycsXG4gICk6IFByb21pc2U8aHR0cC5JbmNvbWluZ01lc3NhZ2U+IHtcbiAgICBpZiAoIWlzT2JqZWN0KG9wdGlvbnMpKSB7XG4gICAgICB0aHJvdyBuZXcgVHlwZUVycm9yKCdvcHRpb25zIHNob3VsZCBiZSBvZiB0eXBlIFwib2JqZWN0XCInKVxuICAgIH1cbiAgICBpZiAoIWlzU3RyaW5nKHBheWxvYWQpICYmICFpc09iamVjdChwYXlsb2FkKSkge1xuICAgICAgLy8gQnVmZmVyIGlzIG9mIHR5cGUgJ29iamVjdCdcbiAgICAgIHRocm93IG5ldyBUeXBlRXJyb3IoJ3BheWxvYWQgc2hvdWxkIGJlIG9mIHR5cGUgXCJzdHJpbmdcIiBvciBcIkJ1ZmZlclwiJylcbiAgICB9XG4gICAgZXhwZWN0ZWRDb2Rlcy5mb3JFYWNoKChzdGF0dXNDb2RlKSA9PiB7XG4gICAgICBpZiAoIWlzTnVtYmVyKHN0YXR1c0NvZGUpKSB7XG4gICAgICAgIHRocm93IG5ldyBUeXBlRXJyb3IoJ3N0YXR1c0NvZGUgc2hvdWxkIGJlIG9mIHR5cGUgXCJudW1iZXJcIicpXG4gICAgICB9XG4gICAgfSlcbiAgICBpZiAoIWlzU3RyaW5nKHJlZ2lvbikpIHtcbiAgICAgIHRocm93IG5ldyBUeXBlRXJyb3IoJ3JlZ2lvbiBzaG91bGQgYmUgb2YgdHlwZSBcInN0cmluZ1wiJylcbiAgICB9XG4gICAgaWYgKCFvcHRpb25zLmhlYWRlcnMpIHtcbiAgICAgIG9wdGlvbnMuaGVhZGVycyA9IHt9XG4gICAgfVxuICAgIGlmIChvcHRpb25zLm1ldGhvZCA9PT0gJ1BPU1QnIHx8IG9wdGlvbnMubWV0aG9kID09PSAnUFVUJyB8fCBvcHRpb25zLm1ldGhvZCA9PT0gJ0RFTEVURScpIHtcbiAgICAgIG9wdGlvbnMuaGVhZGVyc1snY29udGVudC1sZW5ndGgnXSA9IHBheWxvYWQubGVuZ3RoLnRvU3RyaW5nKClcbiAgICB9XG4gICAgY29uc3Qgc2hhMjU2c3VtID0gdGhpcy5lbmFibGVTSEEyNTYgPyB0b1NoYTI1NihwYXlsb2FkKSA6ICcnXG4gICAgcmV0dXJuIHRoaXMubWFrZVJlcXVlc3RTdHJlYW1Bc3luYyhvcHRpb25zLCBwYXlsb2FkLCBzaGEyNTZzdW0sIGV4cGVjdGVkQ29kZXMsIHJlZ2lvbilcbiAgfVxuXG4gIC8qKlxuICAgKiBuZXcgcmVxdWVzdCB3aXRoIHByb21pc2VcbiAgICpcbiAgICogTm8gbmVlZCB0byBkcmFpbiByZXNwb25zZSwgcmVzcG9uc2UgYm9keSBpcyBub3QgdmFsaWRcbiAgICovXG4gIGFzeW5jIG1ha2VSZXF1ZXN0QXN5bmNPbWl0KFxuICAgIG9wdGlvbnM6IFJlcXVlc3RPcHRpb24sXG4gICAgcGF5bG9hZDogQmluYXJ5ID0gJycsXG4gICAgc3RhdHVzQ29kZXM6IG51bWJlcltdID0gWzIwMF0sXG4gICAgcmVnaW9uID0gJycsXG4gICk6IFByb21pc2U8T21pdDxodHRwLkluY29taW5nTWVzc2FnZSwgJ29uJz4+IHtcbiAgICBjb25zdCByZXMgPSBhd2FpdCB0aGlzLm1ha2VSZXF1ZXN0QXN5bmMob3B0aW9ucywgcGF5bG9hZCwgc3RhdHVzQ29kZXMsIHJlZ2lvbilcbiAgICBhd2FpdCBkcmFpblJlc3BvbnNlKHJlcylcbiAgICByZXR1cm4gcmVzXG4gIH1cblxuICAvKipcbiAgICogbWFrZVJlcXVlc3RTdHJlYW0gd2lsbCBiZSB1c2VkIGRpcmVjdGx5IGluc3RlYWQgb2YgbWFrZVJlcXVlc3QgaW4gY2FzZSB0aGUgcGF5bG9hZFxuICAgKiBpcyBhdmFpbGFibGUgYXMgYSBzdHJlYW0uIGZvciBleC4gcHV0T2JqZWN0XG4gICAqXG4gICAqIEBpbnRlcm5hbFxuICAgKi9cbiAgYXN5bmMgbWFrZVJlcXVlc3RTdHJlYW1Bc3luYyhcbiAgICBvcHRpb25zOiBSZXF1ZXN0T3B0aW9uLFxuICAgIGJvZHk6IHN0cmVhbS5SZWFkYWJsZSB8IEJpbmFyeSxcbiAgICBzaGEyNTZzdW06IHN0cmluZyxcbiAgICBzdGF0dXNDb2RlczogbnVtYmVyW10sXG4gICAgcmVnaW9uOiBzdHJpbmcsXG4gICk6IFByb21pc2U8aHR0cC5JbmNvbWluZ01lc3NhZ2U+IHtcbiAgICBpZiAoIWlzT2JqZWN0KG9wdGlvbnMpKSB7XG4gICAgICB0aHJvdyBuZXcgVHlwZUVycm9yKCdvcHRpb25zIHNob3VsZCBiZSBvZiB0eXBlIFwib2JqZWN0XCInKVxuICAgIH1cbiAgICBpZiAoIShCdWZmZXIuaXNCdWZmZXIoYm9keSkgfHwgdHlwZW9mIGJvZHkgPT09ICdzdHJpbmcnIHx8IGlzUmVhZGFibGVTdHJlYW0oYm9keSkpKSB7XG4gICAgICB0aHJvdyBuZXcgZXJyb3JzLkludmFsaWRBcmd1bWVudEVycm9yKFxuICAgICAgICBgc3RyZWFtIHNob3VsZCBiZSBhIEJ1ZmZlciwgc3RyaW5nIG9yIHJlYWRhYmxlIFN0cmVhbSwgZ290ICR7dHlwZW9mIGJvZHl9IGluc3RlYWRgLFxuICAgICAgKVxuICAgIH1cbiAgICBpZiAoIWlzU3RyaW5nKHNoYTI1NnN1bSkpIHtcbiAgICAgIHRocm93IG5ldyBUeXBlRXJyb3IoJ3NoYTI1NnN1bSBzaG91bGQgYmUgb2YgdHlwZSBcInN0cmluZ1wiJylcbiAgICB9XG4gICAgc3RhdHVzQ29kZXMuZm9yRWFjaCgoc3RhdHVzQ29kZSkgPT4ge1xuICAgICAgaWYgKCFpc051bWJlcihzdGF0dXNDb2RlKSkge1xuICAgICAgICB0aHJvdyBuZXcgVHlwZUVycm9yKCdzdGF0dXNDb2RlIHNob3VsZCBiZSBvZiB0eXBlIFwibnVtYmVyXCInKVxuICAgICAgfVxuICAgIH0pXG4gICAgaWYgKCFpc1N0cmluZyhyZWdpb24pKSB7XG4gICAgICB0aHJvdyBuZXcgVHlwZUVycm9yKCdyZWdpb24gc2hvdWxkIGJlIG9mIHR5cGUgXCJzdHJpbmdcIicpXG4gICAgfVxuICAgIC8vIHNoYTI1NnN1bSB3aWxsIGJlIGVtcHR5IGZvciBhbm9ueW1vdXMgb3IgaHR0cHMgcmVxdWVzdHNcbiAgICBpZiAoIXRoaXMuZW5hYmxlU0hBMjU2ICYmIHNoYTI1NnN1bS5sZW5ndGggIT09IDApIHtcbiAgICAgIHRocm93IG5ldyBlcnJvcnMuSW52YWxpZEFyZ3VtZW50RXJyb3IoYHNoYTI1NnN1bSBleHBlY3RlZCB0byBiZSBlbXB0eSBmb3IgYW5vbnltb3VzIG9yIGh0dHBzIHJlcXVlc3RzYClcbiAgICB9XG4gICAgLy8gc2hhMjU2c3VtIHNob3VsZCBiZSB2YWxpZCBmb3Igbm9uLWFub255bW91cyBodHRwIHJlcXVlc3RzLlxuICAgIGlmICh0aGlzLmVuYWJsZVNIQTI1NiAmJiBzaGEyNTZzdW0ubGVuZ3RoICE9PSA2NCkge1xuICAgICAgdGhyb3cgbmV3IGVycm9ycy5JbnZhbGlkQXJndW1lbnRFcnJvcihgSW52YWxpZCBzaGEyNTZzdW0gOiAke3NoYTI1NnN1bX1gKVxuICAgIH1cblxuICAgIGF3YWl0IHRoaXMuY2hlY2tBbmRSZWZyZXNoQ3JlZHMoKVxuXG4gICAgLy8gZXNsaW50LWRpc2FibGUtbmV4dC1saW5lIEB0eXBlc2NyaXB0LWVzbGludC9uby1ub24tbnVsbC1hc3NlcnRpb25cbiAgICByZWdpb24gPSByZWdpb24gfHwgKGF3YWl0IHRoaXMuZ2V0QnVja2V0UmVnaW9uQXN5bmMob3B0aW9ucy5idWNrZXROYW1lISkpXG5cbiAgICBjb25zdCByZXFPcHRpb25zID0gdGhpcy5nZXRSZXF1ZXN0T3B0aW9ucyh7IC4uLm9wdGlvbnMsIHJlZ2lvbiB9KVxuICAgIGlmICghdGhpcy5hbm9ueW1vdXMpIHtcbiAgICAgIC8vIEZvciBub24tYW5vbnltb3VzIGh0dHBzIHJlcXVlc3RzIHNoYTI1NnN1bSBpcyAnVU5TSUdORUQtUEFZTE9BRCcgZm9yIHNpZ25hdHVyZSBjYWxjdWxhdGlvbi5cbiAgICAgIGlmICghdGhpcy5lbmFibGVTSEEyNTYpIHtcbiAgICAgICAgc2hhMjU2c3VtID0gJ1VOU0lHTkVELVBBWUxPQUQnXG4gICAgICB9XG4gICAgICBjb25zdCBkYXRlID0gbmV3IERhdGUoKVxuICAgICAgcmVxT3B0aW9ucy5oZWFkZXJzWyd4LWFtei1kYXRlJ10gPSBtYWtlRGF0ZUxvbmcoZGF0ZSlcbiAgICAgIHJlcU9wdGlvbnMuaGVhZGVyc1sneC1hbXotY29udGVudC1zaGEyNTYnXSA9IHNoYTI1NnN1bVxuICAgICAgaWYgKHRoaXMuc2Vzc2lvblRva2VuKSB7XG4gICAgICAgIHJlcU9wdGlvbnMuaGVhZGVyc1sneC1hbXotc2VjdXJpdHktdG9rZW4nXSA9IHRoaXMuc2Vzc2lvblRva2VuXG4gICAgICB9XG4gICAgICByZXFPcHRpb25zLmhlYWRlcnMuYXV0aG9yaXphdGlvbiA9IHNpZ25WNChyZXFPcHRpb25zLCB0aGlzLmFjY2Vzc0tleSwgdGhpcy5zZWNyZXRLZXksIHJlZ2lvbiwgZGF0ZSwgc2hhMjU2c3VtKVxuICAgIH1cblxuICAgIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgcmVxdWVzdFdpdGhSZXRyeSh0aGlzLnRyYW5zcG9ydCwgcmVxT3B0aW9ucywgYm9keSlcbiAgICBpZiAoIXJlc3BvbnNlLnN0YXR1c0NvZGUpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcIkJVRzogcmVzcG9uc2UgZG9lc24ndCBoYXZlIGEgc3RhdHVzQ29kZVwiKVxuICAgIH1cblxuICAgIGlmICghc3RhdHVzQ29kZXMuaW5jbHVkZXMocmVzcG9uc2Uuc3RhdHVzQ29kZSkpIHtcbiAgICAgIC8vIEZvciBhbiBpbmNvcnJlY3QgcmVnaW9uLCBTMyBzZXJ2ZXIgYWx3YXlzIHNlbmRzIGJhY2sgNDAwLlxuICAgICAgLy8gQnV0IHdlIHdpbGwgZG8gY2FjaGUgaW52YWxpZGF0aW9uIGZvciBhbGwgZXJyb3JzIHNvIHRoYXQsXG4gICAgICAvLyBpbiBmdXR1cmUsIGlmIEFXUyBTMyBkZWNpZGVzIHRvIHNlbmQgYSBkaWZmZXJlbnQgc3RhdHVzIGNvZGUgb3JcbiAgICAgIC8vIFhNTCBlcnJvciBjb2RlIHdlIHdpbGwgc3RpbGwgd29yayBmaW5lLlxuICAgICAgLy8gZXNsaW50LWRpc2FibGUtbmV4dC1saW5lIEB0eXBlc2NyaXB0LWVzbGludC9uby1ub24tbnVsbC1hc3NlcnRpb25cbiAgICAgIGRlbGV0ZSB0aGlzLnJlZ2lvbk1hcFtvcHRpb25zLmJ1Y2tldE5hbWUhXVxuXG4gICAgICBjb25zdCBlcnIgPSBhd2FpdCB4bWxQYXJzZXJzLnBhcnNlUmVzcG9uc2VFcnJvcihyZXNwb25zZSlcbiAgICAgIHRoaXMubG9nSFRUUChyZXFPcHRpb25zLCByZXNwb25zZSwgZXJyKVxuICAgICAgdGhyb3cgZXJyXG4gICAgfVxuXG4gICAgdGhpcy5sb2dIVFRQKHJlcU9wdGlvbnMsIHJlc3BvbnNlKVxuXG4gICAgcmV0dXJuIHJlc3BvbnNlXG4gIH1cblxuICAvKipcbiAgICogZ2V0cyB0aGUgcmVnaW9uIG9mIHRoZSBidWNrZXRcbiAgICpcbiAgICogQHBhcmFtIGJ1Y2tldE5hbWVcbiAgICpcbiAgICovXG4gIGFzeW5jIGdldEJ1Y2tldFJlZ2lvbkFzeW5jKGJ1Y2tldE5hbWU6IHN0cmluZyk6IFByb21pc2U8c3RyaW5nPiB7XG4gICAgaWYgKCFpc1ZhbGlkQnVja2V0TmFtZShidWNrZXROYW1lKSkge1xuICAgICAgdGhyb3cgbmV3IGVycm9ycy5JbnZhbGlkQnVja2V0TmFtZUVycm9yKGBJbnZhbGlkIGJ1Y2tldCBuYW1lIDogJHtidWNrZXROYW1lfWApXG4gICAgfVxuXG4gICAgLy8gUmVnaW9uIGlzIHNldCB3aXRoIGNvbnN0cnVjdG9yLCByZXR1cm4gdGhlIHJlZ2lvbiByaWdodCBoZXJlLlxuICAgIGlmICh0aGlzLnJlZ2lvbikge1xuICAgICAgcmV0dXJuIHRoaXMucmVnaW9uXG4gICAgfVxuXG4gICAgY29uc3QgY2FjaGVkID0gdGhpcy5yZWdpb25NYXBbYnVja2V0TmFtZV1cbiAgICBpZiAoY2FjaGVkKSB7XG4gICAgICByZXR1cm4gY2FjaGVkXG4gICAgfVxuXG4gICAgY29uc3QgZXh0cmFjdFJlZ2lvbkFzeW5jID0gYXN5bmMgKHJlc3BvbnNlOiBodHRwLkluY29taW5nTWVzc2FnZSkgPT4ge1xuICAgICAgY29uc3QgYm9keSA9IGF3YWl0IHJlYWRBc1N0cmluZyhyZXNwb25zZSlcbiAgICAgIGNvbnN0IHJlZ2lvbiA9IHhtbFBhcnNlcnMucGFyc2VCdWNrZXRSZWdpb24oYm9keSkgfHwgREVGQVVMVF9SRUdJT05cbiAgICAgIHRoaXMucmVnaW9uTWFwW2J1Y2tldE5hbWVdID0gcmVnaW9uXG4gICAgICByZXR1cm4gcmVnaW9uXG4gICAgfVxuXG4gICAgY29uc3QgbWV0aG9kID0gJ0dFVCdcbiAgICBjb25zdCBxdWVyeSA9ICdsb2NhdGlvbidcbiAgICAvLyBgZ2V0QnVja2V0TG9jYXRpb25gIGJlaGF2ZXMgZGlmZmVyZW50bHkgaW4gZm9sbG93aW5nIHdheXMgZm9yXG4gICAgLy8gZGlmZmVyZW50IGVudmlyb25tZW50cy5cbiAgICAvL1xuICAgIC8vIC0gRm9yIG5vZGVqcyBlbnYgd2UgZGVmYXVsdCB0byBwYXRoIHN0eWxlIHJlcXVlc3RzLlxuICAgIC8vIC0gRm9yIGJyb3dzZXIgZW52IHBhdGggc3R5bGUgcmVxdWVzdHMgb24gYnVja2V0cyB5aWVsZHMgQ09SU1xuICAgIC8vICAgZXJyb3IuIFRvIGNpcmN1bXZlbnQgdGhpcyBwcm9ibGVtIHdlIG1ha2UgYSB2aXJ0dWFsIGhvc3RcbiAgICAvLyAgIHN0eWxlIHJlcXVlc3Qgc2lnbmVkIHdpdGggJ3VzLWVhc3QtMScuIFRoaXMgcmVxdWVzdCBmYWlsc1xuICAgIC8vICAgd2l0aCBhbiBlcnJvciAnQXV0aG9yaXphdGlvbkhlYWRlck1hbGZvcm1lZCcsIGFkZGl0aW9uYWxseVxuICAgIC8vICAgdGhlIGVycm9yIFhNTCBhbHNvIHByb3ZpZGVzIFJlZ2lvbiBvZiB0aGUgYnVja2V0LiBUbyB2YWxpZGF0ZVxuICAgIC8vICAgdGhpcyByZWdpb24gaXMgcHJvcGVyIHdlIHJldHJ5IHRoZSBzYW1lIHJlcXVlc3Qgd2l0aCB0aGUgbmV3bHlcbiAgICAvLyAgIG9idGFpbmVkIHJlZ2lvbi5cbiAgICBjb25zdCBwYXRoU3R5bGUgPSB0aGlzLnBhdGhTdHlsZSAmJiAhaXNCcm93c2VyXG4gICAgbGV0IHJlZ2lvbjogc3RyaW5nXG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHJlcyA9IGF3YWl0IHRoaXMubWFrZVJlcXVlc3RBc3luYyh7IG1ldGhvZCwgYnVja2V0TmFtZSwgcXVlcnksIHBhdGhTdHlsZSB9LCAnJywgWzIwMF0sIERFRkFVTFRfUkVHSU9OKVxuICAgICAgcmV0dXJuIGV4dHJhY3RSZWdpb25Bc3luYyhyZXMpXG4gICAgfSBjYXRjaCAoZSkge1xuICAgICAgLy8gbWFrZSBhbGlnbm1lbnQgd2l0aCBtYyBjbGlcbiAgICAgIGlmIChlIGluc3RhbmNlb2YgZXJyb3JzLlMzRXJyb3IpIHtcbiAgICAgICAgY29uc3QgZXJyQ29kZSA9IGUuY29kZVxuICAgICAgICBjb25zdCBlcnJSZWdpb24gPSBlLnJlZ2lvblxuICAgICAgICBpZiAoZXJyQ29kZSA9PT0gJ0FjY2Vzc0RlbmllZCcgJiYgIWVyclJlZ2lvbikge1xuICAgICAgICAgIHJldHVybiBERUZBVUxUX1JFR0lPTlxuICAgICAgICB9XG4gICAgICB9XG4gICAgICAvLyBlc2xpbnQtZGlzYWJsZS1uZXh0LWxpbmUgQHR5cGVzY3JpcHQtZXNsaW50L2Jhbi10cy1jb21tZW50XG4gICAgICAvLyBAdHMtaWdub3JlXG4gICAgICBpZiAoIShlLm5hbWUgPT09ICdBdXRob3JpemF0aW9uSGVhZGVyTWFsZm9ybWVkJykpIHtcbiAgICAgICAgdGhyb3cgZVxuICAgICAgfVxuICAgICAgLy8gQHRzLWV4cGVjdC1lcnJvciB3ZSBzZXQgZXh0cmEgcHJvcGVydGllcyBvbiBlcnJvciBvYmplY3RcbiAgICAgIHJlZ2lvbiA9IGUuUmVnaW9uIGFzIHN0cmluZ1xuICAgICAgaWYgKCFyZWdpb24pIHtcbiAgICAgICAgdGhyb3cgZVxuICAgICAgfVxuICAgIH1cblxuICAgIGNvbnN0IHJlcyA9IGF3YWl0IHRoaXMubWFrZVJlcXVlc3RBc3luYyh7IG1ldGhvZCwgYnVja2V0TmFtZSwgcXVlcnksIHBhdGhTdHlsZSB9LCAnJywgWzIwMF0sIHJlZ2lvbilcbiAgICByZXR1cm4gYXdhaXQgZXh0cmFjdFJlZ2lvbkFzeW5jKHJlcylcbiAgfVxuXG4gIC8qKlxuICAgKiBtYWtlUmVxdWVzdCBpcyB0aGUgcHJpbWl0aXZlIHVzZWQgYnkgdGhlIGFwaXMgZm9yIG1ha2luZyBTMyByZXF1ZXN0cy5cbiAgICogcGF5bG9hZCBjYW4gYmUgZW1wdHkgc3RyaW5nIGluIGNhc2Ugb2Ygbm8gcGF5bG9hZC5cbiAgICogc3RhdHVzQ29kZSBpcyB0aGUgZXhwZWN0ZWQgc3RhdHVzQ29kZS4gSWYgcmVzcG9uc2Uuc3RhdHVzQ29kZSBkb2VzIG5vdCBtYXRjaFxuICAgKiB3ZSBwYXJzZSB0aGUgWE1MIGVycm9yIGFuZCBjYWxsIHRoZSBjYWxsYmFjayB3aXRoIHRoZSBlcnJvciBtZXNzYWdlLlxuICAgKiBBIHZhbGlkIHJlZ2lvbiBpcyBwYXNzZWQgYnkgdGhlIGNhbGxzIC0gbGlzdEJ1Y2tldHMsIG1ha2VCdWNrZXQgYW5kXG4gICAqIGdldEJ1Y2tldFJlZ2lvbi5cbiAgICpcbiAgICogQGRlcHJlY2F0ZWQgdXNlIGBtYWtlUmVxdWVzdEFzeW5jYCBpbnN0ZWFkXG4gICAqL1xuICBtYWtlUmVxdWVzdChcbiAgICBvcHRpb25zOiBSZXF1ZXN0T3B0aW9uLFxuICAgIHBheWxvYWQ6IEJpbmFyeSA9ICcnLFxuICAgIGV4cGVjdGVkQ29kZXM6IG51bWJlcltdID0gWzIwMF0sXG4gICAgcmVnaW9uID0gJycsXG4gICAgcmV0dXJuUmVzcG9uc2U6IGJvb2xlYW4sXG4gICAgY2I6IChjYjogdW5rbm93biwgcmVzdWx0OiBodHRwLkluY29taW5nTWVzc2FnZSkgPT4gdm9pZCxcbiAgKSB7XG4gICAgbGV0IHByb206IFByb21pc2U8aHR0cC5JbmNvbWluZ01lc3NhZ2U+XG4gICAgaWYgKHJldHVyblJlc3BvbnNlKSB7XG4gICAgICBwcm9tID0gdGhpcy5tYWtlUmVxdWVzdEFzeW5jKG9wdGlvbnMsIHBheWxvYWQsIGV4cGVjdGVkQ29kZXMsIHJlZ2lvbilcbiAgICB9IGVsc2Uge1xuICAgICAgLy8gZXNsaW50LWRpc2FibGUtbmV4dC1saW5lIEB0eXBlc2NyaXB0LWVzbGludC9iYW4tdHMtY29tbWVudFxuICAgICAgLy8gQHRzLWV4cGVjdC1lcnJvciBjb21wYXRpYmxlIGZvciBvbGQgYmVoYXZpb3VyXG4gICAgICBwcm9tID0gdGhpcy5tYWtlUmVxdWVzdEFzeW5jT21pdChvcHRpb25zLCBwYXlsb2FkLCBleHBlY3RlZENvZGVzLCByZWdpb24pXG4gICAgfVxuXG4gICAgcHJvbS50aGVuKFxuICAgICAgKHJlc3VsdCkgPT4gY2IobnVsbCwgcmVzdWx0KSxcbiAgICAgIChlcnIpID0+IHtcbiAgICAgICAgLy8gZXNsaW50LWRpc2FibGUtbmV4dC1saW5lIEB0eXBlc2NyaXB0LWVzbGludC9iYW4tdHMtY29tbWVudFxuICAgICAgICAvLyBAdHMtaWdub3JlXG4gICAgICAgIGNiKGVycilcbiAgICAgIH0sXG4gICAgKVxuICB9XG5cbiAgLyoqXG4gICAqIG1ha2VSZXF1ZXN0U3RyZWFtIHdpbGwgYmUgdXNlZCBkaXJlY3RseSBpbnN0ZWFkIG9mIG1ha2VSZXF1ZXN0IGluIGNhc2UgdGhlIHBheWxvYWRcbiAgICogaXMgYXZhaWxhYmxlIGFzIGEgc3RyZWFtLiBmb3IgZXguIHB1dE9iamVjdFxuICAgKlxuICAgKiBAZGVwcmVjYXRlZCB1c2UgYG1ha2VSZXF1ZXN0U3RyZWFtQXN5bmNgIGluc3RlYWRcbiAgICovXG4gIG1ha2VSZXF1ZXN0U3RyZWFtKFxuICAgIG9wdGlvbnM6IFJlcXVlc3RPcHRpb24sXG4gICAgc3RyZWFtOiBzdHJlYW0uUmVhZGFibGUgfCBCdWZmZXIsXG4gICAgc2hhMjU2c3VtOiBzdHJpbmcsXG4gICAgc3RhdHVzQ29kZXM6IG51bWJlcltdLFxuICAgIHJlZ2lvbjogc3RyaW5nLFxuICAgIHJldHVyblJlc3BvbnNlOiBib29sZWFuLFxuICAgIGNiOiAoY2I6IHVua25vd24sIHJlc3VsdDogaHR0cC5JbmNvbWluZ01lc3NhZ2UpID0+IHZvaWQsXG4gICkge1xuICAgIGNvbnN0IGV4ZWN1dG9yID0gYXN5bmMgKCkgPT4ge1xuICAgICAgY29uc3QgcmVzID0gYXdhaXQgdGhpcy5tYWtlUmVxdWVzdFN0cmVhbUFzeW5jKG9wdGlvbnMsIHN0cmVhbSwgc2hhMjU2c3VtLCBzdGF0dXNDb2RlcywgcmVnaW9uKVxuICAgICAgaWYgKCFyZXR1cm5SZXNwb25zZSkge1xuICAgICAgICBhd2FpdCBkcmFpblJlc3BvbnNlKHJlcylcbiAgICAgIH1cblxuICAgICAgcmV0dXJuIHJlc1xuICAgIH1cblxuICAgIGV4ZWN1dG9yKCkudGhlbihcbiAgICAgIChyZXN1bHQpID0+IGNiKG51bGwsIHJlc3VsdCksXG4gICAgICAvLyBlc2xpbnQtZGlzYWJsZS1uZXh0LWxpbmUgQHR5cGVzY3JpcHQtZXNsaW50L2Jhbi10cy1jb21tZW50XG4gICAgICAvLyBAdHMtaWdub3JlXG4gICAgICAoZXJyKSA9PiBjYihlcnIpLFxuICAgIClcbiAgfVxuXG4gIC8qKlxuICAgKiBAZGVwcmVjYXRlZCB1c2UgYGdldEJ1Y2tldFJlZ2lvbkFzeW5jYCBpbnN0ZWFkXG4gICAqL1xuICBnZXRCdWNrZXRSZWdpb24oYnVja2V0TmFtZTogc3RyaW5nLCBjYjogKGVycjogdW5rbm93biwgcmVnaW9uOiBzdHJpbmcpID0+IHZvaWQpIHtcbiAgICByZXR1cm4gdGhpcy5nZXRCdWNrZXRSZWdpb25Bc3luYyhidWNrZXROYW1lKS50aGVuKFxuICAgICAgKHJlc3VsdCkgPT4gY2IobnVsbCwgcmVzdWx0KSxcbiAgICAgIC8vIGVzbGludC1kaXNhYmxlLW5leHQtbGluZSBAdHlwZXNjcmlwdC1lc2xpbnQvYmFuLXRzLWNvbW1lbnRcbiAgICAgIC8vIEB0cy1pZ25vcmVcbiAgICAgIChlcnIpID0+IGNiKGVyciksXG4gICAgKVxuICB9XG5cbiAgLy8gQnVja2V0IG9wZXJhdGlvbnNcblxuICAvKipcbiAgICogQ3JlYXRlcyB0aGUgYnVja2V0IGBidWNrZXROYW1lYC5cbiAgICpcbiAgICovXG4gIGFzeW5jIG1ha2VCdWNrZXQoYnVja2V0TmFtZTogc3RyaW5nLCByZWdpb246IFJlZ2lvbiA9ICcnLCBtYWtlT3B0cz86IE1ha2VCdWNrZXRPcHQpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBpZiAoIWlzVmFsaWRCdWNrZXROYW1lKGJ1Y2tldE5hbWUpKSB7XG4gICAgICB0aHJvdyBuZXcgZXJyb3JzLkludmFsaWRCdWNrZXROYW1lRXJyb3IoJ0ludmFsaWQgYnVja2V0IG5hbWU6ICcgKyBidWNrZXROYW1lKVxuICAgIH1cbiAgICAvLyBCYWNrd2FyZCBDb21wYXRpYmlsaXR5XG4gICAgaWYgKGlzT2JqZWN0KHJlZ2lvbikpIHtcbiAgICAgIG1ha2VPcHRzID0gcmVnaW9uXG4gICAgICByZWdpb24gPSAnJ1xuICAgIH1cblxuICAgIGlmICghaXNTdHJpbmcocmVnaW9uKSkge1xuICAgICAgdGhyb3cgbmV3IFR5cGVFcnJvcigncmVnaW9uIHNob3VsZCBiZSBvZiB0eXBlIFwic3RyaW5nXCInKVxuICAgIH1cbiAgICBpZiAobWFrZU9wdHMgJiYgIWlzT2JqZWN0KG1ha2VPcHRzKSkge1xuICAgICAgdGhyb3cgbmV3IFR5cGVFcnJvcignbWFrZU9wdHMgc2hvdWxkIGJlIG9mIHR5cGUgXCJvYmplY3RcIicpXG4gICAgfVxuXG4gICAgbGV0IHBheWxvYWQgPSAnJ1xuXG4gICAgLy8gUmVnaW9uIGFscmVhZHkgc2V0IGluIGNvbnN0cnVjdG9yLCB2YWxpZGF0ZSBpZlxuICAgIC8vIGNhbGxlciByZXF1ZXN0ZWQgYnVja2V0IGxvY2F0aW9uIGlzIHNhbWUuXG4gICAgaWYgKHJlZ2lvbiAmJiB0aGlzLnJlZ2lvbikge1xuICAgICAgaWYgKHJlZ2lvbiAhPT0gdGhpcy5yZWdpb24pIHtcbiAgICAgICAgdGhyb3cgbmV3IGVycm9ycy5JbnZhbGlkQXJndW1lbnRFcnJvcihgQ29uZmlndXJlZCByZWdpb24gJHt0aGlzLnJlZ2lvbn0sIHJlcXVlc3RlZCAke3JlZ2lvbn1gKVxuICAgICAgfVxuICAgIH1cbiAgICAvLyBzZW5kaW5nIG1ha2VCdWNrZXQgcmVxdWVzdCB3aXRoIFhNTCBjb250YWluaW5nICd1cy1lYXN0LTEnIGZhaWxzLiBGb3JcbiAgICAvLyBkZWZhdWx0IHJlZ2lvbiBzZXJ2ZXIgZXhwZWN0cyB0aGUgcmVxdWVzdCB3aXRob3V0IGJvZHlcbiAgICBpZiAocmVnaW9uICYmIHJlZ2lvbiAhPT0gREVGQVVMVF9SRUdJT04pIHtcbiAgICAgIHBheWxvYWQgPSB4bWwuYnVpbGRPYmplY3Qoe1xuICAgICAgICBDcmVhdGVCdWNrZXRDb25maWd1cmF0aW9uOiB7XG4gICAgICAgICAgJDogeyB4bWxuczogJ2h0dHA6Ly9zMy5hbWF6b25hd3MuY29tL2RvYy8yMDA2LTAzLTAxLycgfSxcbiAgICAgICAgICBMb2NhdGlvbkNvbnN0cmFpbnQ6IHJlZ2lvbixcbiAgICAgICAgfSxcbiAgICAgIH0pXG4gICAgfVxuICAgIGNvbnN0IG1ldGhvZCA9ICdQVVQnXG4gICAgY29uc3QgaGVhZGVyczogUmVxdWVzdEhlYWRlcnMgPSB7fVxuXG4gICAgaWYgKG1ha2VPcHRzICYmIG1ha2VPcHRzLk9iamVjdExvY2tpbmcpIHtcbiAgICAgIGhlYWRlcnNbJ3gtYW16LWJ1Y2tldC1vYmplY3QtbG9jay1lbmFibGVkJ10gPSB0cnVlXG4gICAgfVxuXG4gICAgLy8gRm9yIGN1c3RvbSByZWdpb24gY2xpZW50cyAgZGVmYXVsdCB0byBjdXN0b20gcmVnaW9uIHNwZWNpZmllZCBpbiBjbGllbnQgY29uc3RydWN0b3JcbiAgICBjb25zdCBmaW5hbFJlZ2lvbiA9IHRoaXMucmVnaW9uIHx8IHJlZ2lvbiB8fCBERUZBVUxUX1JFR0lPTlxuXG4gICAgY29uc3QgcmVxdWVzdE9wdDogUmVxdWVzdE9wdGlvbiA9IHsgbWV0aG9kLCBidWNrZXROYW1lLCBoZWFkZXJzIH1cblxuICAgIHRyeSB7XG4gICAgICBhd2FpdCB0aGlzLm1ha2VSZXF1ZXN0QXN5bmNPbWl0KHJlcXVlc3RPcHQsIHBheWxvYWQsIFsyMDBdLCBmaW5hbFJlZ2lvbilcbiAgICB9IGNhdGNoIChlcnI6IHVua25vd24pIHtcbiAgICAgIGlmIChyZWdpb24gPT09ICcnIHx8IHJlZ2lvbiA9PT0gREVGQVVMVF9SRUdJT04pIHtcbiAgICAgICAgaWYgKGVyciBpbnN0YW5jZW9mIGVycm9ycy5TM0Vycm9yKSB7XG4gICAgICAgICAgY29uc3QgZXJyQ29kZSA9IGVyci5jb2RlXG4gICAgICAgICAgY29uc3QgZXJyUmVnaW9uID0gZXJyLnJlZ2lvblxuICAgICAgICAgIGlmIChlcnJDb2RlID09PSAnQXV0aG9yaXphdGlvbkhlYWRlck1hbGZvcm1lZCcgJiYgZXJyUmVnaW9uICE9PSAnJykge1xuICAgICAgICAgICAgLy8gUmV0cnkgd2l0aCByZWdpb24gcmV0dXJuZWQgYXMgcGFydCBvZiBlcnJvclxuICAgICAgICAgICAgYXdhaXQgdGhpcy5tYWtlUmVxdWVzdEFzeW5jT21pdChyZXF1ZXN0T3B0LCBwYXlsb2FkLCBbMjAwXSwgZXJyQ29kZSlcbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICAgIHRocm93IGVyclxuICAgIH1cbiAgfVxuXG4gIC8qKlxuICAgKiBUbyBjaGVjayBpZiBhIGJ1Y2tldCBhbHJlYWR5IGV4aXN0cy5cbiAgICovXG4gIGFzeW5jIGJ1Y2tldEV4aXN0cyhidWNrZXROYW1lOiBzdHJpbmcpOiBQcm9taXNlPGJvb2xlYW4+IHtcbiAgICBpZiAoIWlzVmFsaWRCdWNrZXROYW1lKGJ1Y2tldE5hbWUpKSB7XG4gICAgICB0aHJvdyBuZXcgZXJyb3JzLkludmFsaWRCdWNrZXROYW1lRXJyb3IoJ0ludmFsaWQgYnVja2V0IG5hbWU6ICcgKyBidWNrZXROYW1lKVxuICAgIH1cbiAgICBjb25zdCBtZXRob2QgPSAnSEVBRCdcbiAgICB0cnkge1xuICAgICAgYXdhaXQgdGhpcy5tYWtlUmVxdWVzdEFzeW5jT21pdCh7IG1ldGhvZCwgYnVja2V0TmFtZSB9KVxuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgLy8gQHRzLWlnbm9yZVxuICAgICAgaWYgKGVyci5jb2RlID09PSAnTm9TdWNoQnVja2V0JyB8fCBlcnIuY29kZSA9PT0gJ05vdEZvdW5kJykge1xuICAgICAgICByZXR1cm4gZmFsc2VcbiAgICAgIH1cbiAgICAgIHRocm93IGVyclxuICAgIH1cblxuICAgIHJldHVybiB0cnVlXG4gIH1cblxuICBhc3luYyByZW1vdmVCdWNrZXQoYnVja2V0TmFtZTogc3RyaW5nKTogUHJvbWlzZTx2b2lkPlxuXG4gIC8qKlxuICAgKiBAZGVwcmVjYXRlZCB1c2UgcHJvbWlzZSBzdHlsZSBBUElcbiAgICovXG4gIHJlbW92ZUJ1Y2tldChidWNrZXROYW1lOiBzdHJpbmcsIGNhbGxiYWNrOiBOb1Jlc3VsdENhbGxiYWNrKTogdm9pZFxuXG4gIGFzeW5jIHJlbW92ZUJ1Y2tldChidWNrZXROYW1lOiBzdHJpbmcpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBpZiAoIWlzVmFsaWRCdWNrZXROYW1lKGJ1Y2tldE5hbWUpKSB7XG4gICAgICB0aHJvdyBuZXcgZXJyb3JzLkludmFsaWRCdWNrZXROYW1lRXJyb3IoJ0ludmFsaWQgYnVja2V0IG5hbWU6ICcgKyBidWNrZXROYW1lKVxuICAgIH1cbiAgICBjb25zdCBtZXRob2QgPSAnREVMRVRFJ1xuICAgIGF3YWl0IHRoaXMubWFrZVJlcXVlc3RBc3luY09taXQoeyBtZXRob2QsIGJ1Y2tldE5hbWUgfSwgJycsIFsyMDRdKVxuICAgIGRlbGV0ZSB0aGlzLnJlZ2lvbk1hcFtidWNrZXROYW1lXVxuICB9XG5cbiAgLyoqXG4gICAqIENhbGxiYWNrIGlzIGNhbGxlZCB3aXRoIHJlYWRhYmxlIHN0cmVhbSBvZiB0aGUgb2JqZWN0IGNvbnRlbnQuXG4gICAqL1xuICBhc3luYyBnZXRPYmplY3QoYnVja2V0TmFtZTogc3RyaW5nLCBvYmplY3ROYW1lOiBzdHJpbmcsIGdldE9wdHM/OiBHZXRPYmplY3RPcHRzKTogUHJvbWlzZTxzdHJlYW0uUmVhZGFibGU+IHtcbiAgICBpZiAoIWlzVmFsaWRCdWNrZXROYW1lKGJ1Y2tldE5hbWUpKSB7XG4gICAgICB0aHJvdyBuZXcgZXJyb3JzLkludmFsaWRCdWNrZXROYW1lRXJyb3IoJ0ludmFsaWQgYnVja2V0IG5hbWU6ICcgKyBidWNrZXROYW1lKVxuICAgIH1cbiAgICBpZiAoIWlzVmFsaWRPYmplY3ROYW1lKG9iamVjdE5hbWUpKSB7XG4gICAgICB0aHJvdyBuZXcgZXJyb3JzLkludmFsaWRPYmplY3ROYW1lRXJyb3IoYEludmFsaWQgb2JqZWN0IG5hbWU6ICR7b2JqZWN0TmFtZX1gKVxuICAgIH1cbiAgICByZXR1cm4gdGhpcy5nZXRQYXJ0aWFsT2JqZWN0KGJ1Y2tldE5hbWUsIG9iamVjdE5hbWUsIDAsIDAsIGdldE9wdHMpXG4gIH1cblxuICAvKipcbiAgICogQ2FsbGJhY2sgaXMgY2FsbGVkIHdpdGggcmVhZGFibGUgc3RyZWFtIG9mIHRoZSBwYXJ0aWFsIG9iamVjdCBjb250ZW50LlxuICAgKiBAcGFyYW0gYnVja2V0TmFtZVxuICAgKiBAcGFyYW0gb2JqZWN0TmFtZVxuICAgKiBAcGFyYW0gb2Zmc2V0XG4gICAqIEBwYXJhbSBsZW5ndGggLSBsZW5ndGggb2YgdGhlIG9iamVjdCB0aGF0IHdpbGwgYmUgcmVhZCBpbiB0aGUgc3RyZWFtIChvcHRpb25hbCwgaWYgbm90IHNwZWNpZmllZCB3ZSByZWFkIHRoZSByZXN0IG9mIHRoZSBmaWxlIGZyb20gdGhlIG9mZnNldClcbiAgICogQHBhcmFtIGdldE9wdHNcbiAgICovXG4gIGFzeW5jIGdldFBhcnRpYWxPYmplY3QoXG4gICAgYnVja2V0TmFtZTogc3RyaW5nLFxuICAgIG9iamVjdE5hbWU6IHN0cmluZyxcbiAgICBvZmZzZXQ6IG51bWJlcixcbiAgICBsZW5ndGggPSAwLFxuICAgIGdldE9wdHM/OiBHZXRPYmplY3RPcHRzLFxuICApOiBQcm9taXNlPHN0cmVhbS5SZWFkYWJsZT4ge1xuICAgIGlmICghaXNWYWxpZEJ1Y2tldE5hbWUoYnVja2V0TmFtZSkpIHtcbiAgICAgIHRocm93IG5ldyBlcnJvcnMuSW52YWxpZEJ1Y2tldE5hbWVFcnJvcignSW52YWxpZCBidWNrZXQgbmFtZTogJyArIGJ1Y2tldE5hbWUpXG4gICAgfVxuICAgIGlmICghaXNWYWxpZE9iamVjdE5hbWUob2JqZWN0TmFtZSkpIHtcbiAgICAgIHRocm93IG5ldyBlcnJvcnMuSW52YWxpZE9iamVjdE5hbWVFcnJvcihgSW52YWxpZCBvYmplY3QgbmFtZTogJHtvYmplY3ROYW1lfWApXG4gICAgfVxuICAgIGlmICghaXNOdW1iZXIob2Zmc2V0KSkge1xuICAgICAgdGhyb3cgbmV3IFR5cGVFcnJvcignb2Zmc2V0IHNob3VsZCBiZSBvZiB0eXBlIFwibnVtYmVyXCInKVxuICAgIH1cbiAgICBpZiAoIWlzTnVtYmVyKGxlbmd0aCkpIHtcbiAgICAgIHRocm93IG5ldyBUeXBlRXJyb3IoJ2xlbmd0aCBzaG91bGQgYmUgb2YgdHlwZSBcIm51bWJlclwiJylcbiAgICB9XG5cbiAgICBsZXQgcmFuZ2UgPSAnJ1xuICAgIGlmIChvZmZzZXQgfHwgbGVuZ3RoKSB7XG4gICAgICBpZiAob2Zmc2V0KSB7XG4gICAgICAgIHJhbmdlID0gYGJ5dGVzPSR7K29mZnNldH0tYFxuICAgICAgfSBlbHNlIHtcbiAgICAgICAgcmFuZ2UgPSAnYnl0ZXM9MC0nXG4gICAgICAgIG9mZnNldCA9IDBcbiAgICAgIH1cbiAgICAgIGlmIChsZW5ndGgpIHtcbiAgICAgICAgcmFuZ2UgKz0gYCR7K2xlbmd0aCArIG9mZnNldCAtIDF9YFxuICAgICAgfVxuICAgIH1cblxuICAgIGxldCBxdWVyeSA9ICcnXG4gICAgbGV0IGhlYWRlcnM6IFJlcXVlc3RIZWFkZXJzID0ge1xuICAgICAgLi4uKHJhbmdlICE9PSAnJyAmJiB7IHJhbmdlIH0pLFxuICAgIH1cblxuICAgIGlmIChnZXRPcHRzKSB7XG4gICAgICBjb25zdCBzc2VIZWFkZXJzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0ge1xuICAgICAgICAuLi4oZ2V0T3B0cy5TU0VDdXN0b21lckFsZ29yaXRobSAmJiB7XG4gICAgICAgICAgJ1gtQW16LVNlcnZlci1TaWRlLUVuY3J5cHRpb24tQ3VzdG9tZXItQWxnb3JpdGhtJzogZ2V0T3B0cy5TU0VDdXN0b21lckFsZ29yaXRobSxcbiAgICAgICAgfSksXG4gICAgICAgIC4uLihnZXRPcHRzLlNTRUN1c3RvbWVyS2V5ICYmIHsgJ1gtQW16LVNlcnZlci1TaWRlLUVuY3J5cHRpb24tQ3VzdG9tZXItS2V5JzogZ2V0T3B0cy5TU0VDdXN0b21lcktleSB9KSxcbiAgICAgICAgLi4uKGdldE9wdHMuU1NFQ3VzdG9tZXJLZXlNRDUgJiYge1xuICAgICAgICAgICdYLUFtei1TZXJ2ZXItU2lkZS1FbmNyeXB0aW9uLUN1c3RvbWVyLUtleS1NRDUnOiBnZXRPcHRzLlNTRUN1c3RvbWVyS2V5TUQ1LFxuICAgICAgICB9KSxcbiAgICAgIH1cbiAgICAgIHF1ZXJ5ID0gcXMuc3RyaW5naWZ5KGdldE9wdHMpXG4gICAgICBoZWFkZXJzID0ge1xuICAgICAgICAuLi5wcmVwZW5kWEFNWk1ldGEoc3NlSGVhZGVycyksXG4gICAgICAgIC4uLmhlYWRlcnMsXG4gICAgICB9XG4gICAgfVxuXG4gICAgY29uc3QgZXhwZWN0ZWRTdGF0dXNDb2RlcyA9IFsyMDBdXG4gICAgaWYgKHJhbmdlKSB7XG4gICAgICBleHBlY3RlZFN0YXR1c0NvZGVzLnB1c2goMjA2KVxuICAgIH1cbiAgICBjb25zdCBtZXRob2QgPSAnR0VUJ1xuXG4gICAgcmV0dXJuIGF3YWl0IHRoaXMubWFrZVJlcXVlc3RBc3luYyh7IG1ldGhvZCwgYnVja2V0TmFtZSwgb2JqZWN0TmFtZSwgaGVhZGVycywgcXVlcnkgfSwgJycsIGV4cGVjdGVkU3RhdHVzQ29kZXMpXG4gIH1cblxuICAvKipcbiAgICogZG93bmxvYWQgb2JqZWN0IGNvbnRlbnQgdG8gYSBmaWxlLlxuICAgKiBUaGlzIG1ldGhvZCB3aWxsIGNyZWF0ZSBhIHRlbXAgZmlsZSBuYW1lZCBgJHtmaWxlbmFtZX0uJHtiYXNlNjQoZXRhZyl9LnBhcnQubWluaW9gIHdoZW4gZG93bmxvYWRpbmcuXG4gICAqXG4gICAqIEBwYXJhbSBidWNrZXROYW1lIC0gbmFtZSBvZiB0aGUgYnVja2V0XG4gICAqIEBwYXJhbSBvYmplY3ROYW1lIC0gbmFtZSBvZiB0aGUgb2JqZWN0XG4gICAqIEBwYXJhbSBmaWxlUGF0aCAtIHBhdGggdG8gd2hpY2ggdGhlIG9iamVjdCBkYXRhIHdpbGwgYmUgd3JpdHRlbiB0b1xuICAgKiBAcGFyYW0gZ2V0T3B0cyAtIE9wdGlvbmFsIG9iamVjdCBnZXQgb3B0aW9uXG4gICAqL1xuICBhc3luYyBmR2V0T2JqZWN0KGJ1Y2tldE5hbWU6IHN0cmluZywgb2JqZWN0TmFtZTogc3RyaW5nLCBmaWxlUGF0aDogc3RyaW5nLCBnZXRPcHRzPzogR2V0T2JqZWN0T3B0cyk6IFByb21pc2U8dm9pZD4ge1xuICAgIC8vIElucHV0IHZhbGlkYXRpb24uXG4gICAgaWYgKCFpc1ZhbGlkQnVja2V0TmFtZShidWNrZXROYW1lKSkge1xuICAgICAgdGhyb3cgbmV3IGVycm9ycy5JbnZhbGlkQnVja2V0TmFtZUVycm9yKCdJbnZhbGlkIGJ1Y2tldCBuYW1lOiAnICsgYnVja2V0TmFtZSlcbiAgICB9XG4gICAgaWYgKCFpc1ZhbGlkT2JqZWN0TmFtZShvYmplY3ROYW1lKSkge1xuICAgICAgdGhyb3cgbmV3IGVycm9ycy5JbnZhbGlkT2JqZWN0TmFtZUVycm9yKGBJbnZhbGlkIG9iamVjdCBuYW1lOiAke29iamVjdE5hbWV9YClcbiAgICB9XG4gICAgaWYgKCFpc1N0cmluZyhmaWxlUGF0aCkpIHtcbiAgICAgIHRocm93IG5ldyBUeXBlRXJyb3IoJ2ZpbGVQYXRoIHNob3VsZCBiZSBvZiB0eXBlIFwic3RyaW5nXCInKVxuICAgIH1cblxuICAgIGNvbnN0IGRvd25sb2FkVG9UbXBGaWxlID0gYXN5bmMgKCk6IFByb21pc2U8c3RyaW5nPiA9PiB7XG4gICAgICBsZXQgcGFydEZpbGVTdHJlYW06IHN0cmVhbS5Xcml0YWJsZVxuICAgICAgY29uc3Qgb2JqU3RhdCA9IGF3YWl0IHRoaXMuc3RhdE9iamVjdChidWNrZXROYW1lLCBvYmplY3ROYW1lLCBnZXRPcHRzKVxuICAgICAgY29uc3QgZW5jb2RlZEV0YWcgPSBCdWZmZXIuZnJvbShvYmpTdGF0LmV0YWcpLnRvU3RyaW5nKCdiYXNlNjQnKVxuICAgICAgY29uc3QgcGFydEZpbGUgPSBgJHtmaWxlUGF0aH0uJHtlbmNvZGVkRXRhZ30ucGFydC5taW5pb2BcblxuICAgICAgYXdhaXQgZnNwLm1rZGlyKHBhdGguZGlybmFtZShmaWxlUGF0aCksIHsgcmVjdXJzaXZlOiB0cnVlIH0pXG5cbiAgICAgIGxldCBvZmZzZXQgPSAwXG4gICAgICB0cnkge1xuICAgICAgICBjb25zdCBzdGF0cyA9IGF3YWl0IGZzcC5zdGF0KHBhcnRGaWxlKVxuICAgICAgICBpZiAob2JqU3RhdC5zaXplID09PSBzdGF0cy5zaXplKSB7XG4gICAgICAgICAgcmV0dXJuIHBhcnRGaWxlXG4gICAgICAgIH1cbiAgICAgICAgb2Zmc2V0ID0gc3RhdHMuc2l6ZVxuICAgICAgICBwYXJ0RmlsZVN0cmVhbSA9IGZzLmNyZWF0ZVdyaXRlU3RyZWFtKHBhcnRGaWxlLCB7IGZsYWdzOiAnYScgfSlcbiAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgaWYgKGUgaW5zdGFuY2VvZiBFcnJvciAmJiAoZSBhcyB1bmtub3duIGFzIHsgY29kZTogc3RyaW5nIH0pLmNvZGUgPT09ICdFTk9FTlQnKSB7XG4gICAgICAgICAgLy8gZmlsZSBub3QgZXhpc3RcbiAgICAgICAgICBwYXJ0RmlsZVN0cmVhbSA9IGZzLmNyZWF0ZVdyaXRlU3RyZWFtKHBhcnRGaWxlLCB7IGZsYWdzOiAndycgfSlcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAvLyBvdGhlciBlcnJvciwgbWF5YmUgYWNjZXNzIGRlbnlcbiAgICAgICAgICB0aHJvdyBlXG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgY29uc3QgZG93bmxvYWRTdHJlYW0gPSBhd2FpdCB0aGlzLmdldFBhcnRpYWxPYmplY3QoYnVja2V0TmFtZSwgb2JqZWN0TmFtZSwgb2Zmc2V0LCAwLCBnZXRPcHRzKVxuXG4gICAgICBhd2FpdCBzdHJlYW1Qcm9taXNlLnBpcGVsaW5lKGRvd25sb2FkU3RyZWFtLCBwYXJ0RmlsZVN0cmVhbSlcbiAgICAgIGNvbnN0IHN0YXRzID0gYXdhaXQgZnNwLnN0YXQocGFydEZpbGUpXG4gICAgICBpZiAoc3RhdHMuc2l6ZSA9PT0gb2JqU3RhdC5zaXplKSB7XG4gICAgICAgIHJldHVybiBwYXJ0RmlsZVxuICAgICAgfVxuXG4gICAgICB0aHJvdyBuZXcgRXJyb3IoJ1NpemUgbWlzbWF0Y2ggYmV0d2VlbiBkb3dubG9hZGVkIGZpbGUgYW5kIHRoZSBvYmplY3QnKVxuICAgIH1cblxuICAgIGNvbnN0IHBhcnRGaWxlID0gYXdhaXQgZG93bmxvYWRUb1RtcEZpbGUoKVxuICAgIGF3YWl0IGZzcC5yZW5hbWUocGFydEZpbGUsIGZpbGVQYXRoKVxuICB9XG5cbiAgLyoqXG4gICAqIFN0YXQgaW5mb3JtYXRpb24gb2YgdGhlIG9iamVjdC5cbiAgICovXG4gIGFzeW5jIHN0YXRPYmplY3QoYnVja2V0TmFtZTogc3RyaW5nLCBvYmplY3ROYW1lOiBzdHJpbmcsIHN0YXRPcHRzPzogU3RhdE9iamVjdE9wdHMpOiBQcm9taXNlPEJ1Y2tldEl0ZW1TdGF0PiB7XG4gICAgY29uc3Qgc3RhdE9wdERlZiA9IHN0YXRPcHRzIHx8IHt9XG4gICAgaWYgKCFpc1ZhbGlkQnVja2V0TmFtZShidWNrZXROYW1lKSkge1xuICAgICAgdGhyb3cgbmV3IGVycm9ycy5JbnZhbGlkQnVja2V0TmFtZUVycm9yKCdJbnZhbGlkIGJ1Y2tldCBuYW1lOiAnICsgYnVja2V0TmFtZSlcbiAgICB9XG4gICAgaWYgKCFpc1ZhbGlkT2JqZWN0TmFtZShvYmplY3ROYW1lKSkge1xuICAgICAgdGhyb3cgbmV3IGVycm9ycy5JbnZhbGlkT2JqZWN0TmFtZUVycm9yKGBJbnZhbGlkIG9iamVjdCBuYW1lOiAke29iamVjdE5hbWV9YClcbiAgICB9XG5cbiAgICBpZiAoIWlzT2JqZWN0KHN0YXRPcHREZWYpKSB7XG4gICAgICB0aHJvdyBuZXcgZXJyb3JzLkludmFsaWRBcmd1bWVudEVycm9yKCdzdGF0T3B0cyBzaG91bGQgYmUgb2YgdHlwZSBcIm9iamVjdFwiJylcbiAgICB9XG5cbiAgICBjb25zdCBxdWVyeSA9IHFzLnN0cmluZ2lmeShzdGF0T3B0RGVmKVxuICAgIGNvbnN0IG1ldGhvZCA9ICdIRUFEJ1xuICAgIGNvbnN0IHJlcyA9IGF3YWl0IHRoaXMubWFrZVJlcXVlc3RBc3luY09taXQoeyBtZXRob2QsIGJ1Y2tldE5hbWUsIG9iamVjdE5hbWUsIHF1ZXJ5IH0pXG5cbiAgICByZXR1cm4ge1xuICAgICAgc2l6ZTogcGFyc2VJbnQocmVzLmhlYWRlcnNbJ2NvbnRlbnQtbGVuZ3RoJ10gYXMgc3RyaW5nKSxcbiAgICAgIG1ldGFEYXRhOiBleHRyYWN0TWV0YWRhdGEocmVzLmhlYWRlcnMgYXMgUmVzcG9uc2VIZWFkZXIpLFxuICAgICAgbGFzdE1vZGlmaWVkOiBuZXcgRGF0ZShyZXMuaGVhZGVyc1snbGFzdC1tb2RpZmllZCddIGFzIHN0cmluZyksXG4gICAgICB2ZXJzaW9uSWQ6IGdldFZlcnNpb25JZChyZXMuaGVhZGVycyBhcyBSZXNwb25zZUhlYWRlciksXG4gICAgICBldGFnOiBzYW5pdGl6ZUVUYWcocmVzLmhlYWRlcnMuZXRhZyksXG4gICAgfVxuICB9XG5cbiAgYXN5bmMgcmVtb3ZlT2JqZWN0KGJ1Y2tldE5hbWU6IHN0cmluZywgb2JqZWN0TmFtZTogc3RyaW5nLCByZW1vdmVPcHRzPzogUmVtb3ZlT3B0aW9ucyk6IFByb21pc2U8dm9pZD4ge1xuICAgIGlmICghaXNWYWxpZEJ1Y2tldE5hbWUoYnVja2V0TmFtZSkpIHtcbiAgICAgIHRocm93IG5ldyBlcnJvcnMuSW52YWxpZEJ1Y2tldE5hbWVFcnJvcihgSW52YWxpZCBidWNrZXQgbmFtZTogJHtidWNrZXROYW1lfWApXG4gICAgfVxuICAgIGlmICghaXNWYWxpZE9iamVjdE5hbWUob2JqZWN0TmFtZSkpIHtcbiAgICAgIHRocm93IG5ldyBlcnJvcnMuSW52YWxpZE9iamVjdE5hbWVFcnJvcihgSW52YWxpZCBvYmplY3QgbmFtZTogJHtvYmplY3ROYW1lfWApXG4gICAgfVxuXG4gICAgaWYgKHJlbW92ZU9wdHMgJiYgIWlzT2JqZWN0KHJlbW92ZU9wdHMpKSB7XG4gICAgICB0aHJvdyBuZXcgZXJyb3JzLkludmFsaWRBcmd1bWVudEVycm9yKCdyZW1vdmVPcHRzIHNob3VsZCBiZSBvZiB0eXBlIFwib2JqZWN0XCInKVxuICAgIH1cblxuICAgIGNvbnN0IG1ldGhvZCA9ICdERUxFVEUnXG5cbiAgICBjb25zdCBoZWFkZXJzOiBSZXF1ZXN0SGVhZGVycyA9IHt9XG4gICAgaWYgKHJlbW92ZU9wdHM/LmdvdmVybmFuY2VCeXBhc3MpIHtcbiAgICAgIGhlYWRlcnNbJ1gtQW16LUJ5cGFzcy1Hb3Zlcm5hbmNlLVJldGVudGlvbiddID0gdHJ1ZVxuICAgIH1cbiAgICBpZiAocmVtb3ZlT3B0cz8uZm9yY2VEZWxldGUpIHtcbiAgICAgIGhlYWRlcnNbJ3gtbWluaW8tZm9yY2UtZGVsZXRlJ10gPSB0cnVlXG4gICAgfVxuXG4gICAgY29uc3QgcXVlcnlQYXJhbXM6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7fVxuICAgIGlmIChyZW1vdmVPcHRzPy52ZXJzaW9uSWQpIHtcbiAgICAgIHF1ZXJ5UGFyYW1zLnZlcnNpb25JZCA9IGAke3JlbW92ZU9wdHMudmVyc2lvbklkfWBcbiAgICB9XG4gICAgY29uc3QgcXVlcnkgPSBxcy5zdHJpbmdpZnkocXVlcnlQYXJhbXMpXG5cbiAgICBhd2FpdCB0aGlzLm1ha2VSZXF1ZXN0QXN5bmNPbWl0KHsgbWV0aG9kLCBidWNrZXROYW1lLCBvYmplY3ROYW1lLCBoZWFkZXJzLCBxdWVyeSB9LCAnJywgWzIwMCwgMjA0XSlcbiAgfVxuXG4gIC8vIENhbGxzIGltcGxlbWVudGVkIGJlbG93IGFyZSByZWxhdGVkIHRvIG11bHRpcGFydC5cblxuICBsaXN0SW5jb21wbGV0ZVVwbG9hZHMoXG4gICAgYnVja2V0OiBzdHJpbmcsXG4gICAgcHJlZml4OiBzdHJpbmcsXG4gICAgcmVjdXJzaXZlOiBib29sZWFuLFxuICApOiBCdWNrZXRTdHJlYW08SW5jb21wbGV0ZVVwbG9hZGVkQnVja2V0SXRlbT4ge1xuICAgIGlmIChwcmVmaXggPT09IHVuZGVmaW5lZCkge1xuICAgICAgcHJlZml4ID0gJydcbiAgICB9XG4gICAgaWYgKHJlY3Vyc2l2ZSA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICByZWN1cnNpdmUgPSBmYWxzZVxuICAgIH1cbiAgICBpZiAoIWlzVmFsaWRCdWNrZXROYW1lKGJ1Y2tldCkpIHtcbiAgICAgIHRocm93IG5ldyBlcnJvcnMuSW52YWxpZEJ1Y2tldE5hbWVFcnJvcignSW52YWxpZCBidWNrZXQgbmFtZTogJyArIGJ1Y2tldClcbiAgICB9XG4gICAgaWYgKCFpc1ZhbGlkUHJlZml4KHByZWZpeCkpIHtcbiAgICAgIHRocm93IG5ldyBlcnJvcnMuSW52YWxpZFByZWZpeEVycm9yKGBJbnZhbGlkIHByZWZpeCA6ICR7cHJlZml4fWApXG4gICAgfVxuICAgIGlmICghaXNCb29sZWFuKHJlY3Vyc2l2ZSkpIHtcbiAgICAgIHRocm93IG5ldyBUeXBlRXJyb3IoJ3JlY3Vyc2l2ZSBzaG91bGQgYmUgb2YgdHlwZSBcImJvb2xlYW5cIicpXG4gICAgfVxuICAgIGNvbnN0IGRlbGltaXRlciA9IHJlY3Vyc2l2ZSA/ICcnIDogJy8nXG4gICAgbGV0IGtleU1hcmtlciA9ICcnXG4gICAgbGV0IHVwbG9hZElkTWFya2VyID0gJydcbiAgICBjb25zdCB1cGxvYWRzOiB1bmtub3duW10gPSBbXVxuICAgIGxldCBlbmRlZCA9IGZhbHNlXG5cbiAgICAvLyBUT0RPOiByZWZhY3RvciB0aGlzIHdpdGggYXN5bmMvYXdhaXQgYW5kIGBzdHJlYW0uUmVhZGFibGUuZnJvbWBcbiAgICBjb25zdCByZWFkU3RyZWFtID0gbmV3IHN0cmVhbS5SZWFkYWJsZSh7IG9iamVjdE1vZGU6IHRydWUgfSlcbiAgICByZWFkU3RyZWFtLl9yZWFkID0gKCkgPT4ge1xuICAgICAgLy8gcHVzaCBvbmUgdXBsb2FkIGluZm8gcGVyIF9yZWFkKClcbiAgICAgIGlmICh1cGxvYWRzLmxlbmd0aCkge1xuICAgICAgICByZXR1cm4gcmVhZFN0cmVhbS5wdXNoKHVwbG9hZHMuc2hpZnQoKSlcbiAgICAgIH1cbiAgICAgIGlmIChlbmRlZCkge1xuICAgICAgICByZXR1cm4gcmVhZFN0cmVhbS5wdXNoKG51bGwpXG4gICAgICB9XG4gICAgICB0aGlzLmxpc3RJbmNvbXBsZXRlVXBsb2Fkc1F1ZXJ5KGJ1Y2tldCwgcHJlZml4LCBrZXlNYXJrZXIsIHVwbG9hZElkTWFya2VyLCBkZWxpbWl0ZXIpLnRoZW4oXG4gICAgICAgIChyZXN1bHQpID0+IHtcbiAgICAgICAgICAvLyBlc2xpbnQtZGlzYWJsZS1uZXh0LWxpbmUgQHR5cGVzY3JpcHQtZXNsaW50L2Jhbi10cy1jb21tZW50XG4gICAgICAgICAgLy8gQHRzLWlnbm9yZVxuICAgICAgICAgIHJlc3VsdC5wcmVmaXhlcy5mb3JFYWNoKChwcmVmaXgpID0+IHVwbG9hZHMucHVzaChwcmVmaXgpKVxuICAgICAgICAgIGFzeW5jLmVhY2hTZXJpZXMoXG4gICAgICAgICAgICByZXN1bHQudXBsb2FkcyxcbiAgICAgICAgICAgICh1cGxvYWQsIGNiKSA9PiB7XG4gICAgICAgICAgICAgIC8vIGZvciBlYWNoIGluY29tcGxldGUgdXBsb2FkIGFkZCB0aGUgc2l6ZXMgb2YgaXRzIHVwbG9hZGVkIHBhcnRzXG4gICAgICAgICAgICAgIC8vIGVzbGludC1kaXNhYmxlLW5leHQtbGluZSBAdHlwZXNjcmlwdC1lc2xpbnQvYmFuLXRzLWNvbW1lbnRcbiAgICAgICAgICAgICAgLy8gQHRzLWlnbm9yZVxuICAgICAgICAgICAgICB0aGlzLmxpc3RQYXJ0cyhidWNrZXQsIHVwbG9hZC5rZXksIHVwbG9hZC51cGxvYWRJZCkudGhlbihcbiAgICAgICAgICAgICAgICAocGFydHM6IFBhcnRbXSkgPT4ge1xuICAgICAgICAgICAgICAgICAgLy8gZXNsaW50LWRpc2FibGUtbmV4dC1saW5lIEB0eXBlc2NyaXB0LWVzbGludC9iYW4tdHMtY29tbWVudFxuICAgICAgICAgICAgICAgICAgLy8gQHRzLWlnbm9yZVxuICAgICAgICAgICAgICAgICAgdXBsb2FkLnNpemUgPSBwYXJ0cy5yZWR1Y2UoKGFjYywgaXRlbSkgPT4gYWNjICsgaXRlbS5zaXplLCAwKVxuICAgICAgICAgICAgICAgICAgdXBsb2Fkcy5wdXNoKHVwbG9hZClcbiAgICAgICAgICAgICAgICAgIGNiKClcbiAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgIChlcnI6IEVycm9yKSA9PiBjYihlcnIpLFxuICAgICAgICAgICAgICApXG4gICAgICAgICAgICB9LFxuICAgICAgICAgICAgKGVycikgPT4ge1xuICAgICAgICAgICAgICBpZiAoZXJyKSB7XG4gICAgICAgICAgICAgICAgcmVhZFN0cmVhbS5lbWl0KCdlcnJvcicsIGVycilcbiAgICAgICAgICAgICAgICByZXR1cm5cbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICBpZiAocmVzdWx0LmlzVHJ1bmNhdGVkKSB7XG4gICAgICAgICAgICAgICAga2V5TWFya2VyID0gcmVzdWx0Lm5leHRLZXlNYXJrZXJcbiAgICAgICAgICAgICAgICB1cGxvYWRJZE1hcmtlciA9IHJlc3VsdC5uZXh0VXBsb2FkSWRNYXJrZXJcbiAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBlbmRlZCA9IHRydWVcbiAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgIC8vIGVzbGludC1kaXNhYmxlLW5leHQtbGluZSBAdHlwZXNjcmlwdC1lc2xpbnQvYmFuLXRzLWNvbW1lbnRcbiAgICAgICAgICAgICAgLy8gQHRzLWlnbm9yZVxuICAgICAgICAgICAgICByZWFkU3RyZWFtLl9yZWFkKClcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgKVxuICAgICAgICB9LFxuICAgICAgICAoZSkgPT4ge1xuICAgICAgICAgIHJlYWRTdHJlYW0uZW1pdCgnZXJyb3InLCBlKVxuICAgICAgICB9LFxuICAgICAgKVxuICAgIH1cbiAgICByZXR1cm4gcmVhZFN0cmVhbVxuICB9XG5cbiAgLyoqXG4gICAqIENhbGxlZCBieSBsaXN0SW5jb21wbGV0ZVVwbG9hZHMgdG8gZmV0Y2ggYSBiYXRjaCBvZiBpbmNvbXBsZXRlIHVwbG9hZHMuXG4gICAqL1xuICBhc3luYyBsaXN0SW5jb21wbGV0ZVVwbG9hZHNRdWVyeShcbiAgICBidWNrZXROYW1lOiBzdHJpbmcsXG4gICAgcHJlZml4OiBzdHJpbmcsXG4gICAga2V5TWFya2VyOiBzdHJpbmcsXG4gICAgdXBsb2FkSWRNYXJrZXI6IHN0cmluZyxcbiAgICBkZWxpbWl0ZXI6IHN0cmluZyxcbiAgKTogUHJvbWlzZTxMaXN0TXVsdGlwYXJ0UmVzdWx0PiB7XG4gICAgaWYgKCFpc1ZhbGlkQnVja2V0TmFtZShidWNrZXROYW1lKSkge1xuICAgICAgdGhyb3cgbmV3IGVycm9ycy5JbnZhbGlkQnVja2V0TmFtZUVycm9yKCdJbnZhbGlkIGJ1Y2tldCBuYW1lOiAnICsgYnVja2V0TmFtZSlcbiAgICB9XG4gICAgaWYgKCFpc1N0cmluZyhwcmVmaXgpKSB7XG4gICAgICB0aHJvdyBuZXcgVHlwZUVycm9yKCdwcmVmaXggc2hvdWxkIGJlIG9mIHR5cGUgXCJzdHJpbmdcIicpXG4gICAgfVxuICAgIGlmICghaXNTdHJpbmcoa2V5TWFya2VyKSkge1xuICAgICAgdGhyb3cgbmV3IFR5cGVFcnJvcigna2V5TWFya2VyIHNob3VsZCBiZSBvZiB0eXBlIFwic3RyaW5nXCInKVxuICAgIH1cbiAgICBpZiAoIWlzU3RyaW5nKHVwbG9hZElkTWFya2VyKSkge1xuICAgICAgdGhyb3cgbmV3IFR5cGVFcnJvcigndXBsb2FkSWRNYXJrZXIgc2hvdWxkIGJlIG9mIHR5cGUgXCJzdHJpbmdcIicpXG4gICAgfVxuICAgIGlmICghaXNTdHJpbmcoZGVsaW1pdGVyKSkge1xuICAgICAgdGhyb3cgbmV3IFR5cGVFcnJvcignZGVsaW1pdGVyIHNob3VsZCBiZSBvZiB0eXBlIFwic3RyaW5nXCInKVxuICAgIH1cbiAgICBjb25zdCBxdWVyaWVzID0gW11cbiAgICBxdWVyaWVzLnB1c2goYHByZWZpeD0ke3VyaUVzY2FwZShwcmVmaXgpfWApXG4gICAgcXVlcmllcy5wdXNoKGBkZWxpbWl0ZXI9JHt1cmlFc2NhcGUoZGVsaW1pdGVyKX1gKVxuXG4gICAgaWYgKGtleU1hcmtlcikge1xuICAgICAgcXVlcmllcy5wdXNoKGBrZXktbWFya2VyPSR7dXJpRXNjYXBlKGtleU1hcmtlcil9YClcbiAgICB9XG4gICAgaWYgKHVwbG9hZElkTWFya2VyKSB7XG4gICAgICBxdWVyaWVzLnB1c2goYHVwbG9hZC1pZC1tYXJrZXI9JHt1cGxvYWRJZE1hcmtlcn1gKVxuICAgIH1cblxuICAgIGNvbnN0IG1heFVwbG9hZHMgPSAxMDAwXG4gICAgcXVlcmllcy5wdXNoKGBtYXgtdXBsb2Fkcz0ke21heFVwbG9hZHN9YClcbiAgICBxdWVyaWVzLnNvcnQoKVxuICAgIHF1ZXJpZXMudW5zaGlmdCgndXBsb2FkcycpXG4gICAgbGV0IHF1ZXJ5ID0gJydcbiAgICBpZiAocXVlcmllcy5sZW5ndGggPiAwKSB7XG4gICAgICBxdWVyeSA9IGAke3F1ZXJpZXMuam9pbignJicpfWBcbiAgICB9XG4gICAgY29uc3QgbWV0aG9kID0gJ0dFVCdcbiAgICBjb25zdCByZXMgPSBhd2FpdCB0aGlzLm1ha2VSZXF1ZXN0QXN5bmMoeyBtZXRob2QsIGJ1Y2tldE5hbWUsIHF1ZXJ5IH0pXG4gICAgY29uc3QgYm9keSA9IGF3YWl0IHJlYWRBc1N0cmluZyhyZXMpXG4gICAgcmV0dXJuIHhtbFBhcnNlcnMucGFyc2VMaXN0TXVsdGlwYXJ0KGJvZHkpXG4gIH1cblxuICAvKipcbiAgICogSW5pdGlhdGUgYSBuZXcgbXVsdGlwYXJ0IHVwbG9hZC5cbiAgICogQGludGVybmFsXG4gICAqL1xuICBhc3luYyBpbml0aWF0ZU5ld011bHRpcGFydFVwbG9hZChidWNrZXROYW1lOiBzdHJpbmcsIG9iamVjdE5hbWU6IHN0cmluZywgaGVhZGVyczogUmVxdWVzdEhlYWRlcnMpOiBQcm9taXNlPHN0cmluZz4ge1xuICAgIGlmICghaXNWYWxpZEJ1Y2tldE5hbWUoYnVja2V0TmFtZSkpIHtcbiAgICAgIHRocm93IG5ldyBlcnJvcnMuSW52YWxpZEJ1Y2tldE5hbWVFcnJvcignSW52YWxpZCBidWNrZXQgbmFtZTogJyArIGJ1Y2tldE5hbWUpXG4gICAgfVxuICAgIGlmICghaXNWYWxpZE9iamVjdE5hbWUob2JqZWN0TmFtZSkpIHtcbiAgICAgIHRocm93IG5ldyBlcnJvcnMuSW52YWxpZE9iamVjdE5hbWVFcnJvcihgSW52YWxpZCBvYmplY3QgbmFtZTogJHtvYmplY3ROYW1lfWApXG4gICAgfVxuICAgIGlmICghaXNPYmplY3QoaGVhZGVycykpIHtcbiAgICAgIHRocm93IG5ldyBlcnJvcnMuSW52YWxpZE9iamVjdE5hbWVFcnJvcignY29udGVudFR5cGUgc2hvdWxkIGJlIG9mIHR5cGUgXCJvYmplY3RcIicpXG4gICAgfVxuICAgIGNvbnN0IG1ldGhvZCA9ICdQT1NUJ1xuICAgIGNvbnN0IHF1ZXJ5ID0gJ3VwbG9hZHMnXG4gICAgY29uc3QgcmVzID0gYXdhaXQgdGhpcy5tYWtlUmVxdWVzdEFzeW5jKHsgbWV0aG9kLCBidWNrZXROYW1lLCBvYmplY3ROYW1lLCBxdWVyeSwgaGVhZGVycyB9KVxuICAgIGNvbnN0IGJvZHkgPSBhd2FpdCByZWFkQXNCdWZmZXIocmVzKVxuICAgIHJldHVybiBwYXJzZUluaXRpYXRlTXVsdGlwYXJ0KGJvZHkudG9TdHJpbmcoKSlcbiAgfVxuXG4gIC8qKlxuICAgKiBJbnRlcm5hbCBNZXRob2QgdG8gYWJvcnQgYSBtdWx0aXBhcnQgdXBsb2FkIHJlcXVlc3QgaW4gY2FzZSBvZiBhbnkgZXJyb3JzLlxuICAgKlxuICAgKiBAcGFyYW0gYnVja2V0TmFtZSAtIEJ1Y2tldCBOYW1lXG4gICAqIEBwYXJhbSBvYmplY3ROYW1lIC0gT2JqZWN0IE5hbWVcbiAgICogQHBhcmFtIHVwbG9hZElkIC0gaWQgb2YgYSBtdWx0aXBhcnQgdXBsb2FkIHRvIGNhbmNlbCBkdXJpbmcgY29tcG9zZSBvYmplY3Qgc2VxdWVuY2UuXG4gICAqL1xuICBhc3luYyBhYm9ydE11bHRpcGFydFVwbG9hZChidWNrZXROYW1lOiBzdHJpbmcsIG9iamVjdE5hbWU6IHN0cmluZywgdXBsb2FkSWQ6IHN0cmluZyk6IFByb21pc2U8dm9pZD4ge1xuICAgIGNvbnN0IG1ldGhvZCA9ICdERUxFVEUnXG4gICAgY29uc3QgcXVlcnkgPSBgdXBsb2FkSWQ9JHt1cGxvYWRJZH1gXG5cbiAgICBjb25zdCByZXF1ZXN0T3B0aW9ucyA9IHsgbWV0aG9kLCBidWNrZXROYW1lLCBvYmplY3ROYW1lOiBvYmplY3ROYW1lLCBxdWVyeSB9XG4gICAgYXdhaXQgdGhpcy5tYWtlUmVxdWVzdEFzeW5jT21pdChyZXF1ZXN0T3B0aW9ucywgJycsIFsyMDRdKVxuICB9XG5cbiAgYXN5bmMgZmluZFVwbG9hZElkKGJ1Y2tldE5hbWU6IHN0cmluZywgb2JqZWN0TmFtZTogc3RyaW5nKTogUHJvbWlzZTxzdHJpbmcgfCB1bmRlZmluZWQ+IHtcbiAgICBpZiAoIWlzVmFsaWRCdWNrZXROYW1lKGJ1Y2tldE5hbWUpKSB7XG4gICAgICB0aHJvdyBuZXcgZXJyb3JzLkludmFsaWRCdWNrZXROYW1lRXJyb3IoJ0ludmFsaWQgYnVja2V0IG5hbWU6ICcgKyBidWNrZXROYW1lKVxuICAgIH1cbiAgICBpZiAoIWlzVmFsaWRPYmplY3ROYW1lKG9iamVjdE5hbWUpKSB7XG4gICAgICB0aHJvdyBuZXcgZXJyb3JzLkludmFsaWRPYmplY3ROYW1lRXJyb3IoYEludmFsaWQgb2JqZWN0IG5hbWU6ICR7b2JqZWN0TmFtZX1gKVxuICAgIH1cblxuICAgIGxldCBsYXRlc3RVcGxvYWQ6IExpc3RNdWx0aXBhcnRSZXN1bHRbJ3VwbG9hZHMnXVtudW1iZXJdIHwgdW5kZWZpbmVkXG4gICAgbGV0IGtleU1hcmtlciA9ICcnXG4gICAgbGV0IHVwbG9hZElkTWFya2VyID0gJydcbiAgICBmb3IgKDs7KSB7XG4gICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCB0aGlzLmxpc3RJbmNvbXBsZXRlVXBsb2Fkc1F1ZXJ5KGJ1Y2tldE5hbWUsIG9iamVjdE5hbWUsIGtleU1hcmtlciwgdXBsb2FkSWRNYXJrZXIsICcnKVxuICAgICAgZm9yIChjb25zdCB1cGxvYWQgb2YgcmVzdWx0LnVwbG9hZHMpIHtcbiAgICAgICAgaWYgKHVwbG9hZC5rZXkgPT09IG9iamVjdE5hbWUpIHtcbiAgICAgICAgICBpZiAoIWxhdGVzdFVwbG9hZCB8fCB1cGxvYWQuaW5pdGlhdGVkLmdldFRpbWUoKSA+IGxhdGVzdFVwbG9hZC5pbml0aWF0ZWQuZ2V0VGltZSgpKSB7XG4gICAgICAgICAgICBsYXRlc3RVcGxvYWQgPSB1cGxvYWRcbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICAgIGlmIChyZXN1bHQuaXNUcnVuY2F0ZWQpIHtcbiAgICAgICAga2V5TWFya2VyID0gcmVzdWx0Lm5leHRLZXlNYXJrZXJcbiAgICAgICAgdXBsb2FkSWRNYXJrZXIgPSByZXN1bHQubmV4dFVwbG9hZElkTWFya2VyXG4gICAgICAgIGNvbnRpbnVlXG4gICAgICB9XG5cbiAgICAgIGJyZWFrXG4gICAgfVxuICAgIHJldHVybiBsYXRlc3RVcGxvYWQ/LnVwbG9hZElkXG4gIH1cblxuICAvKipcbiAgICogdGhpcyBjYWxsIHdpbGwgYWdncmVnYXRlIHRoZSBwYXJ0cyBvbiB0aGUgc2VydmVyIGludG8gYSBzaW5nbGUgb2JqZWN0LlxuICAgKi9cbiAgYXN5bmMgY29tcGxldGVNdWx0aXBhcnRVcGxvYWQoXG4gICAgYnVja2V0TmFtZTogc3RyaW5nLFxuICAgIG9iamVjdE5hbWU6IHN0cmluZyxcbiAgICB1cGxvYWRJZDogc3RyaW5nLFxuICAgIGV0YWdzOiB7XG4gICAgICBwYXJ0OiBudW1iZXJcbiAgICAgIGV0YWc/OiBzdHJpbmdcbiAgICB9W10sXG4gICk6IFByb21pc2U8eyBldGFnOiBzdHJpbmc7IHZlcnNpb25JZDogc3RyaW5nIHwgbnVsbCB9PiB7XG4gICAgaWYgKCFpc1ZhbGlkQnVja2V0TmFtZShidWNrZXROYW1lKSkge1xuICAgICAgdGhyb3cgbmV3IGVycm9ycy5JbnZhbGlkQnVja2V0TmFtZUVycm9yKCdJbnZhbGlkIGJ1Y2tldCBuYW1lOiAnICsgYnVja2V0TmFtZSlcbiAgICB9XG4gICAgaWYgKCFpc1ZhbGlkT2JqZWN0TmFtZShvYmplY3ROYW1lKSkge1xuICAgICAgdGhyb3cgbmV3IGVycm9ycy5JbnZhbGlkT2JqZWN0TmFtZUVycm9yKGBJbnZhbGlkIG9iamVjdCBuYW1lOiAke29iamVjdE5hbWV9YClcbiAgICB9XG4gICAgaWYgKCFpc1N0cmluZyh1cGxvYWRJZCkpIHtcbiAgICAgIHRocm93IG5ldyBUeXBlRXJyb3IoJ3VwbG9hZElkIHNob3VsZCBiZSBvZiB0eXBlIFwic3RyaW5nXCInKVxuICAgIH1cbiAgICBpZiAoIWlzT2JqZWN0KGV0YWdzKSkge1xuICAgICAgdGhyb3cgbmV3IFR5cGVFcnJvcignZXRhZ3Mgc2hvdWxkIGJlIG9mIHR5cGUgXCJBcnJheVwiJylcbiAgICB9XG5cbiAgICBpZiAoIXVwbG9hZElkKSB7XG4gICAgICB0aHJvdyBuZXcgZXJyb3JzLkludmFsaWRBcmd1bWVudEVycm9yKCd1cGxvYWRJZCBjYW5ub3QgYmUgZW1wdHknKVxuICAgIH1cblxuICAgIGNvbnN0IG1ldGhvZCA9ICdQT1NUJ1xuICAgIGNvbnN0IHF1ZXJ5ID0gYHVwbG9hZElkPSR7dXJpRXNjYXBlKHVwbG9hZElkKX1gXG5cbiAgICBjb25zdCBidWlsZGVyID0gbmV3IHhtbDJqcy5CdWlsZGVyKClcbiAgICBjb25zdCBwYXlsb2FkID0gYnVpbGRlci5idWlsZE9iamVjdCh7XG4gICAgICBDb21wbGV0ZU11bHRpcGFydFVwbG9hZDoge1xuICAgICAgICAkOiB7XG4gICAgICAgICAgeG1sbnM6ICdodHRwOi8vczMuYW1hem9uYXdzLmNvbS9kb2MvMjAwNi0wMy0wMS8nLFxuICAgICAgICB9LFxuICAgICAgICBQYXJ0OiBldGFncy5tYXAoKGV0YWcpID0+IHtcbiAgICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgUGFydE51bWJlcjogZXRhZy5wYXJ0LFxuICAgICAgICAgICAgRVRhZzogZXRhZy5ldGFnLFxuICAgICAgICAgIH1cbiAgICAgICAgfSksXG4gICAgICB9LFxuICAgIH0pXG5cbiAgICBjb25zdCByZXMgPSBhd2FpdCB0aGlzLm1ha2VSZXF1ZXN0QXN5bmMoeyBtZXRob2QsIGJ1Y2tldE5hbWUsIG9iamVjdE5hbWUsIHF1ZXJ5IH0sIHBheWxvYWQpXG4gICAgY29uc3QgYm9keSA9IGF3YWl0IHJlYWRBc0J1ZmZlcihyZXMpXG4gICAgY29uc3QgcmVzdWx0ID0gcGFyc2VDb21wbGV0ZU11bHRpcGFydChib2R5LnRvU3RyaW5nKCkpXG4gICAgaWYgKCFyZXN1bHQpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcignQlVHOiBmYWlsZWQgdG8gcGFyc2Ugc2VydmVyIHJlc3BvbnNlJylcbiAgICB9XG5cbiAgICBpZiAocmVzdWx0LmVyckNvZGUpIHtcbiAgICAgIC8vIE11bHRpcGFydCBDb21wbGV0ZSBBUEkgcmV0dXJucyBhbiBlcnJvciBYTUwgYWZ0ZXIgYSAyMDAgaHR0cCBzdGF0dXNcbiAgICAgIHRocm93IG5ldyBlcnJvcnMuUzNFcnJvcihyZXN1bHQuZXJyTWVzc2FnZSlcbiAgICB9XG5cbiAgICByZXR1cm4ge1xuICAgICAgLy8gZXNsaW50LWRpc2FibGUtbmV4dC1saW5lIEB0eXBlc2NyaXB0LWVzbGludC9iYW4tdHMtY29tbWVudFxuICAgICAgLy8gQHRzLWlnbm9yZVxuICAgICAgZXRhZzogcmVzdWx0LmV0YWcgYXMgc3RyaW5nLFxuICAgICAgdmVyc2lvbklkOiBnZXRWZXJzaW9uSWQocmVzLmhlYWRlcnMgYXMgUmVzcG9uc2VIZWFkZXIpLFxuICAgIH1cbiAgfVxuXG4gIC8qKlxuICAgKiBHZXQgcGFydC1pbmZvIG9mIGFsbCBwYXJ0cyBvZiBhbiBpbmNvbXBsZXRlIHVwbG9hZCBzcGVjaWZpZWQgYnkgdXBsb2FkSWQuXG4gICAqL1xuICBwcm90ZWN0ZWQgYXN5bmMgbGlzdFBhcnRzKGJ1Y2tldE5hbWU6IHN0cmluZywgb2JqZWN0TmFtZTogc3RyaW5nLCB1cGxvYWRJZDogc3RyaW5nKTogUHJvbWlzZTxVcGxvYWRlZFBhcnRbXT4ge1xuICAgIGlmICghaXNWYWxpZEJ1Y2tldE5hbWUoYnVja2V0TmFtZSkpIHtcbiAgICAgIHRocm93IG5ldyBlcnJvcnMuSW52YWxpZEJ1Y2tldE5hbWVFcnJvcignSW52YWxpZCBidWNrZXQgbmFtZTogJyArIGJ1Y2tldE5hbWUpXG4gICAgfVxuICAgIGlmICghaXNWYWxpZE9iamVjdE5hbWUob2JqZWN0TmFtZSkpIHtcbiAgICAgIHRocm93IG5ldyBlcnJvcnMuSW52YWxpZE9iamVjdE5hbWVFcnJvcihgSW52YWxpZCBvYmplY3QgbmFtZTogJHtvYmplY3ROYW1lfWApXG4gICAgfVxuICAgIGlmICghaXNTdHJpbmcodXBsb2FkSWQpKSB7XG4gICAgICB0aHJvdyBuZXcgVHlwZUVycm9yKCd1cGxvYWRJZCBzaG91bGQgYmUgb2YgdHlwZSBcInN0cmluZ1wiJylcbiAgICB9XG4gICAgaWYgKCF1cGxvYWRJZCkge1xuICAgICAgdGhyb3cgbmV3IGVycm9ycy5JbnZhbGlkQXJndW1lbnRFcnJvcigndXBsb2FkSWQgY2Fubm90IGJlIGVtcHR5JylcbiAgICB9XG5cbiAgICBjb25zdCBwYXJ0czogVXBsb2FkZWRQYXJ0W10gPSBbXVxuICAgIGxldCBtYXJrZXIgPSAwXG4gICAgbGV0IHJlc3VsdFxuICAgIGRvIHtcbiAgICAgIHJlc3VsdCA9IGF3YWl0IHRoaXMubGlzdFBhcnRzUXVlcnkoYnVja2V0TmFtZSwgb2JqZWN0TmFtZSwgdXBsb2FkSWQsIG1hcmtlcilcbiAgICAgIG1hcmtlciA9IHJlc3VsdC5tYXJrZXJcbiAgICAgIHBhcnRzLnB1c2goLi4ucmVzdWx0LnBhcnRzKVxuICAgIH0gd2hpbGUgKHJlc3VsdC5pc1RydW5jYXRlZClcblxuICAgIHJldHVybiBwYXJ0c1xuICB9XG5cbiAgLyoqXG4gICAqIENhbGxlZCBieSBsaXN0UGFydHMgdG8gZmV0Y2ggYSBiYXRjaCBvZiBwYXJ0LWluZm9cbiAgICovXG4gIHByaXZhdGUgYXN5bmMgbGlzdFBhcnRzUXVlcnkoYnVja2V0TmFtZTogc3RyaW5nLCBvYmplY3ROYW1lOiBzdHJpbmcsIHVwbG9hZElkOiBzdHJpbmcsIG1hcmtlcjogbnVtYmVyKSB7XG4gICAgaWYgKCFpc1ZhbGlkQnVja2V0TmFtZShidWNrZXROYW1lKSkge1xuICAgICAgdGhyb3cgbmV3IGVycm9ycy5JbnZhbGlkQnVja2V0TmFtZUVycm9yKCdJbnZhbGlkIGJ1Y2tldCBuYW1lOiAnICsgYnVja2V0TmFtZSlcbiAgICB9XG4gICAgaWYgKCFpc1ZhbGlkT2JqZWN0TmFtZShvYmplY3ROYW1lKSkge1xuICAgICAgdGhyb3cgbmV3IGVycm9ycy5JbnZhbGlkT2JqZWN0TmFtZUVycm9yKGBJbnZhbGlkIG9iamVjdCBuYW1lOiAke29iamVjdE5hbWV9YClcbiAgICB9XG4gICAgaWYgKCFpc1N0cmluZyh1cGxvYWRJZCkpIHtcbiAgICAgIHRocm93IG5ldyBUeXBlRXJyb3IoJ3VwbG9hZElkIHNob3VsZCBiZSBvZiB0eXBlIFwic3RyaW5nXCInKVxuICAgIH1cbiAgICBpZiAoIWlzTnVtYmVyKG1hcmtlcikpIHtcbiAgICAgIHRocm93IG5ldyBUeXBlRXJyb3IoJ21hcmtlciBzaG91bGQgYmUgb2YgdHlwZSBcIm51bWJlclwiJylcbiAgICB9XG4gICAgaWYgKCF1cGxvYWRJZCkge1xuICAgICAgdGhyb3cgbmV3IGVycm9ycy5JbnZhbGlkQXJndW1lbnRFcnJvcigndXBsb2FkSWQgY2Fubm90IGJlIGVtcHR5JylcbiAgICB9XG5cbiAgICBsZXQgcXVlcnkgPSBgdXBsb2FkSWQ9JHt1cmlFc2NhcGUodXBsb2FkSWQpfWBcbiAgICBpZiAobWFya2VyKSB7XG4gICAgICBxdWVyeSArPSBgJnBhcnQtbnVtYmVyLW1hcmtlcj0ke21hcmtlcn1gXG4gICAgfVxuXG4gICAgY29uc3QgbWV0aG9kID0gJ0dFVCdcbiAgICBjb25zdCByZXMgPSBhd2FpdCB0aGlzLm1ha2VSZXF1ZXN0QXN5bmMoeyBtZXRob2QsIGJ1Y2tldE5hbWUsIG9iamVjdE5hbWUsIHF1ZXJ5IH0pXG4gICAgcmV0dXJuIHhtbFBhcnNlcnMucGFyc2VMaXN0UGFydHMoYXdhaXQgcmVhZEFzU3RyaW5nKHJlcykpXG4gIH1cblxuICBhc3luYyBsaXN0QnVja2V0cygpOiBQcm9taXNlPEJ1Y2tldEl0ZW1Gcm9tTGlzdFtdPiB7XG4gICAgY29uc3QgbWV0aG9kID0gJ0dFVCdcbiAgICBjb25zdCByZWdpb25Db25mID0gdGhpcy5yZWdpb24gfHwgREVGQVVMVF9SRUdJT05cbiAgICBjb25zdCBodHRwUmVzID0gYXdhaXQgdGhpcy5tYWtlUmVxdWVzdEFzeW5jKHsgbWV0aG9kIH0sICcnLCBbMjAwXSwgcmVnaW9uQ29uZilcbiAgICBjb25zdCB4bWxSZXN1bHQgPSBhd2FpdCByZWFkQXNTdHJpbmcoaHR0cFJlcylcbiAgICByZXR1cm4geG1sUGFyc2Vycy5wYXJzZUxpc3RCdWNrZXQoeG1sUmVzdWx0KVxuICB9XG5cbiAgLyoqXG4gICAqIENhbGN1bGF0ZSBwYXJ0IHNpemUgZ2l2ZW4gdGhlIG9iamVjdCBzaXplLiBQYXJ0IHNpemUgd2lsbCBiZSBhdGxlYXN0IHRoaXMucGFydFNpemVcbiAgICovXG4gIGNhbGN1bGF0ZVBhcnRTaXplKHNpemU6IG51bWJlcikge1xuICAgIGlmICghaXNOdW1iZXIoc2l6ZSkpIHtcbiAgICAgIHRocm93IG5ldyBUeXBlRXJyb3IoJ3NpemUgc2hvdWxkIGJlIG9mIHR5cGUgXCJudW1iZXJcIicpXG4gICAgfVxuICAgIGlmIChzaXplID4gdGhpcy5tYXhPYmplY3RTaXplKSB7XG4gICAgICB0aHJvdyBuZXcgVHlwZUVycm9yKGBzaXplIHNob3VsZCBub3QgYmUgbW9yZSB0aGFuICR7dGhpcy5tYXhPYmplY3RTaXplfWApXG4gICAgfVxuICAgIGlmICh0aGlzLm92ZXJSaWRlUGFydFNpemUpIHtcbiAgICAgIHJldHVybiB0aGlzLnBhcnRTaXplXG4gICAgfVxuICAgIGxldCBwYXJ0U2l6ZSA9IHRoaXMucGFydFNpemVcbiAgICBmb3IgKDs7KSB7XG4gICAgICAvLyB3aGlsZSh0cnVlKSB7Li4ufSB0aHJvd3MgbGludGluZyBlcnJvci5cbiAgICAgIC8vIElmIHBhcnRTaXplIGlzIGJpZyBlbm91Z2ggdG8gYWNjb21vZGF0ZSB0aGUgb2JqZWN0IHNpemUsIHRoZW4gdXNlIGl0LlxuICAgICAgaWYgKHBhcnRTaXplICogMTAwMDAgPiBzaXplKSB7XG4gICAgICAgIHJldHVybiBwYXJ0U2l6ZVxuICAgICAgfVxuICAgICAgLy8gVHJ5IHBhcnQgc2l6ZXMgYXMgNjRNQiwgODBNQiwgOTZNQiBldGMuXG4gICAgICBwYXJ0U2l6ZSArPSAxNiAqIDEwMjQgKiAxMDI0XG4gICAgfVxuICB9XG5cbiAgLyoqXG4gICAqIFVwbG9hZHMgdGhlIG9iamVjdCB1c2luZyBjb250ZW50cyBmcm9tIGEgZmlsZVxuICAgKi9cbiAgYXN5bmMgZlB1dE9iamVjdChidWNrZXROYW1lOiBzdHJpbmcsIG9iamVjdE5hbWU6IHN0cmluZywgZmlsZVBhdGg6IHN0cmluZywgbWV0YURhdGE/OiBPYmplY3RNZXRhRGF0YSkge1xuICAgIGlmICghaXNWYWxpZEJ1Y2tldE5hbWUoYnVja2V0TmFtZSkpIHtcbiAgICAgIHRocm93IG5ldyBlcnJvcnMuSW52YWxpZEJ1Y2tldE5hbWVFcnJvcignSW52YWxpZCBidWNrZXQgbmFtZTogJyArIGJ1Y2tldE5hbWUpXG4gICAgfVxuICAgIGlmICghaXNWYWxpZE9iamVjdE5hbWUob2JqZWN0TmFtZSkpIHtcbiAgICAgIHRocm93IG5ldyBlcnJvcnMuSW52YWxpZE9iamVjdE5hbWVFcnJvcihgSW52YWxpZCBvYmplY3QgbmFtZTogJHtvYmplY3ROYW1lfWApXG4gICAgfVxuXG4gICAgaWYgKCFpc1N0cmluZyhmaWxlUGF0aCkpIHtcbiAgICAgIHRocm93IG5ldyBUeXBlRXJyb3IoJ2ZpbGVQYXRoIHNob3VsZCBiZSBvZiB0eXBlIFwic3RyaW5nXCInKVxuICAgIH1cbiAgICBpZiAobWV0YURhdGEgJiYgIWlzT2JqZWN0KG1ldGFEYXRhKSkge1xuICAgICAgdGhyb3cgbmV3IFR5cGVFcnJvcignbWV0YURhdGEgc2hvdWxkIGJlIG9mIHR5cGUgXCJvYmplY3RcIicpXG4gICAgfVxuXG4gICAgLy8gSW5zZXJ0cyBjb3JyZWN0IGBjb250ZW50LXR5cGVgIGF0dHJpYnV0ZSBiYXNlZCBvbiBtZXRhRGF0YSBhbmQgZmlsZVBhdGhcbiAgICBtZXRhRGF0YSA9IGluc2VydENvbnRlbnRUeXBlKG1ldGFEYXRhIHx8IHt9LCBmaWxlUGF0aClcbiAgICBjb25zdCBzdGF0ID0gYXdhaXQgZnNwLnN0YXQoZmlsZVBhdGgpXG4gICAgcmV0dXJuIGF3YWl0IHRoaXMucHV0T2JqZWN0KGJ1Y2tldE5hbWUsIG9iamVjdE5hbWUsIGZzLmNyZWF0ZVJlYWRTdHJlYW0oZmlsZVBhdGgpLCBzdGF0LnNpemUsIG1ldGFEYXRhKVxuICB9XG5cbiAgLyoqXG4gICAqICBVcGxvYWRpbmcgYSBzdHJlYW0sIFwiQnVmZmVyXCIgb3IgXCJzdHJpbmdcIi5cbiAgICogIEl0J3MgcmVjb21tZW5kZWQgdG8gcGFzcyBgc2l6ZWAgYXJndW1lbnQgd2l0aCBzdHJlYW0uXG4gICAqL1xuICBhc3luYyBwdXRPYmplY3QoXG4gICAgYnVja2V0TmFtZTogc3RyaW5nLFxuICAgIG9iamVjdE5hbWU6IHN0cmluZyxcbiAgICBzdHJlYW06IHN0cmVhbS5SZWFkYWJsZSB8IEJ1ZmZlciB8IHN0cmluZyxcbiAgICBzaXplPzogbnVtYmVyLFxuICAgIG1ldGFEYXRhPzogSXRlbUJ1Y2tldE1ldGFkYXRhLFxuICApOiBQcm9taXNlPFVwbG9hZGVkT2JqZWN0SW5mbz4ge1xuICAgIGlmICghaXNWYWxpZEJ1Y2tldE5hbWUoYnVja2V0TmFtZSkpIHtcbiAgICAgIHRocm93IG5ldyBlcnJvcnMuSW52YWxpZEJ1Y2tldE5hbWVFcnJvcihgSW52YWxpZCBidWNrZXQgbmFtZTogJHtidWNrZXROYW1lfWApXG4gICAgfVxuICAgIGlmICghaXNWYWxpZE9iamVjdE5hbWUob2JqZWN0TmFtZSkpIHtcbiAgICAgIHRocm93IG5ldyBlcnJvcnMuSW52YWxpZE9iamVjdE5hbWVFcnJvcihgSW52YWxpZCBvYmplY3QgbmFtZTogJHtvYmplY3ROYW1lfWApXG4gICAgfVxuXG4gICAgLy8gV2UnbGwgbmVlZCB0byBzaGlmdCBhcmd1bWVudHMgdG8gdGhlIGxlZnQgYmVjYXVzZSBvZiBtZXRhRGF0YVxuICAgIC8vIGFuZCBzaXplIGJlaW5nIG9wdGlvbmFsLlxuICAgIGlmIChpc09iamVjdChzaXplKSkge1xuICAgICAgbWV0YURhdGEgPSBzaXplXG4gICAgfVxuICAgIC8vIEVuc3VyZXMgTWV0YWRhdGEgaGFzIGFwcHJvcHJpYXRlIHByZWZpeCBmb3IgQTMgQVBJXG4gICAgY29uc3QgaGVhZGVycyA9IHByZXBlbmRYQU1aTWV0YShtZXRhRGF0YSlcbiAgICBpZiAodHlwZW9mIHN0cmVhbSA9PT0gJ3N0cmluZycgfHwgc3RyZWFtIGluc3RhbmNlb2YgQnVmZmVyKSB7XG4gICAgICAvLyBBZGFwdHMgdGhlIG5vbi1zdHJlYW0gaW50ZXJmYWNlIGludG8gYSBzdHJlYW0uXG4gICAgICBzaXplID0gc3RyZWFtLmxlbmd0aFxuICAgICAgc3RyZWFtID0gcmVhZGFibGVTdHJlYW0oc3RyZWFtKVxuICAgIH0gZWxzZSBpZiAoIWlzUmVhZGFibGVTdHJlYW0oc3RyZWFtKSkge1xuICAgICAgdGhyb3cgbmV3IFR5cGVFcnJvcigndGhpcmQgYXJndW1lbnQgc2hvdWxkIGJlIG9mIHR5cGUgXCJzdHJlYW0uUmVhZGFibGVcIiBvciBcIkJ1ZmZlclwiIG9yIFwic3RyaW5nXCInKVxuICAgIH1cblxuICAgIGlmIChpc051bWJlcihzaXplKSAmJiBzaXplIDwgMCkge1xuICAgICAgdGhyb3cgbmV3IGVycm9ycy5JbnZhbGlkQXJndW1lbnRFcnJvcihgc2l6ZSBjYW5ub3QgYmUgbmVnYXRpdmUsIGdpdmVuIHNpemU6ICR7c2l6ZX1gKVxuICAgIH1cblxuICAgIC8vIEdldCB0aGUgcGFydCBzaXplIGFuZCBmb3J3YXJkIHRoYXQgdG8gdGhlIEJsb2NrU3RyZWFtLiBEZWZhdWx0IHRvIHRoZVxuICAgIC8vIGxhcmdlc3QgYmxvY2sgc2l6ZSBwb3NzaWJsZSBpZiBuZWNlc3NhcnkuXG4gICAgaWYgKCFpc051bWJlcihzaXplKSkge1xuICAgICAgc2l6ZSA9IHRoaXMubWF4T2JqZWN0U2l6ZVxuICAgIH1cblxuICAgIC8vIEdldCB0aGUgcGFydCBzaXplIGFuZCBmb3J3YXJkIHRoYXQgdG8gdGhlIEJsb2NrU3RyZWFtLiBEZWZhdWx0IHRvIHRoZVxuICAgIC8vIGxhcmdlc3QgYmxvY2sgc2l6ZSBwb3NzaWJsZSBpZiBuZWNlc3NhcnkuXG4gICAgaWYgKHNpemUgPT09IHVuZGVmaW5lZCkge1xuICAgICAgY29uc3Qgc3RhdFNpemUgPSBhd2FpdCBnZXRDb250ZW50TGVuZ3RoKHN0cmVhbSlcbiAgICAgIGlmIChzdGF0U2l6ZSAhPT0gbnVsbCkge1xuICAgICAgICBzaXplID0gc3RhdFNpemVcbiAgICAgIH1cbiAgICB9XG5cbiAgICBpZiAoIWlzTnVtYmVyKHNpemUpKSB7XG4gICAgICAvLyBCYWNrd2FyZCBjb21wYXRpYmlsaXR5XG4gICAgICBzaXplID0gdGhpcy5tYXhPYmplY3RTaXplXG4gICAgfVxuICAgIGlmIChzaXplID09PSAwKSB7XG4gICAgICByZXR1cm4gdGhpcy51cGxvYWRCdWZmZXIoYnVja2V0TmFtZSwgb2JqZWN0TmFtZSwgaGVhZGVycywgQnVmZmVyLmZyb20oJycpKVxuICAgIH1cblxuICAgIGNvbnN0IHBhcnRTaXplID0gdGhpcy5jYWxjdWxhdGVQYXJ0U2l6ZShzaXplKVxuICAgIGlmICh0eXBlb2Ygc3RyZWFtID09PSAnc3RyaW5nJyB8fCBCdWZmZXIuaXNCdWZmZXIoc3RyZWFtKSB8fCBzaXplIDw9IHBhcnRTaXplKSB7XG4gICAgICBjb25zdCBidWYgPSBpc1JlYWRhYmxlU3RyZWFtKHN0cmVhbSkgPyBhd2FpdCByZWFkQXNCdWZmZXIoc3RyZWFtKSA6IEJ1ZmZlci5mcm9tKHN0cmVhbSlcbiAgICAgIHJldHVybiB0aGlzLnVwbG9hZEJ1ZmZlcihidWNrZXROYW1lLCBvYmplY3ROYW1lLCBoZWFkZXJzLCBidWYpXG4gICAgfVxuXG4gICAgcmV0dXJuIHRoaXMudXBsb2FkU3RyZWFtKGJ1Y2tldE5hbWUsIG9iamVjdE5hbWUsIGhlYWRlcnMsIHN0cmVhbSwgcGFydFNpemUpXG4gIH1cblxuICAvKipcbiAgICogbWV0aG9kIHRvIHVwbG9hZCBidWZmZXIgaW4gb25lIGNhbGxcbiAgICogQHByaXZhdGVcbiAgICovXG4gIHByaXZhdGUgYXN5bmMgdXBsb2FkQnVmZmVyKFxuICAgIGJ1Y2tldE5hbWU6IHN0cmluZyxcbiAgICBvYmplY3ROYW1lOiBzdHJpbmcsXG4gICAgaGVhZGVyczogUmVxdWVzdEhlYWRlcnMsXG4gICAgYnVmOiBCdWZmZXIsXG4gICk6IFByb21pc2U8VXBsb2FkZWRPYmplY3RJbmZvPiB7XG4gICAgY29uc3QgeyBtZDVzdW0sIHNoYTI1NnN1bSB9ID0gaGFzaEJpbmFyeShidWYsIHRoaXMuZW5hYmxlU0hBMjU2KVxuICAgIGhlYWRlcnNbJ0NvbnRlbnQtTGVuZ3RoJ10gPSBidWYubGVuZ3RoXG4gICAgaWYgKCF0aGlzLmVuYWJsZVNIQTI1Nikge1xuICAgICAgaGVhZGVyc1snQ29udGVudC1NRDUnXSA9IG1kNXN1bVxuICAgIH1cbiAgICBjb25zdCByZXMgPSBhd2FpdCB0aGlzLm1ha2VSZXF1ZXN0U3RyZWFtQXN5bmMoXG4gICAgICB7XG4gICAgICAgIG1ldGhvZDogJ1BVVCcsXG4gICAgICAgIGJ1Y2tldE5hbWUsXG4gICAgICAgIG9iamVjdE5hbWUsXG4gICAgICAgIGhlYWRlcnMsXG4gICAgICB9LFxuICAgICAgYnVmLFxuICAgICAgc2hhMjU2c3VtLFxuICAgICAgWzIwMF0sXG4gICAgICAnJyxcbiAgICApXG4gICAgYXdhaXQgZHJhaW5SZXNwb25zZShyZXMpXG4gICAgcmV0dXJuIHtcbiAgICAgIGV0YWc6IHNhbml0aXplRVRhZyhyZXMuaGVhZGVycy5ldGFnKSxcbiAgICAgIHZlcnNpb25JZDogZ2V0VmVyc2lvbklkKHJlcy5oZWFkZXJzIGFzIFJlc3BvbnNlSGVhZGVyKSxcbiAgICB9XG4gIH1cblxuICAvKipcbiAgICogdXBsb2FkIHN0cmVhbSB3aXRoIE11bHRpcGFydFVwbG9hZFxuICAgKiBAcHJpdmF0ZVxuICAgKi9cbiAgcHJpdmF0ZSBhc3luYyB1cGxvYWRTdHJlYW0oXG4gICAgYnVja2V0TmFtZTogc3RyaW5nLFxuICAgIG9iamVjdE5hbWU6IHN0cmluZyxcbiAgICBoZWFkZXJzOiBSZXF1ZXN0SGVhZGVycyxcbiAgICBib2R5OiBzdHJlYW0uUmVhZGFibGUsXG4gICAgcGFydFNpemU6IG51bWJlcixcbiAgKTogUHJvbWlzZTxVcGxvYWRlZE9iamVjdEluZm8+IHtcbiAgICAvLyBBIG1hcCBvZiB0aGUgcHJldmlvdXNseSB1cGxvYWRlZCBjaHVua3MsIGZvciByZXN1bWluZyBhIGZpbGUgdXBsb2FkLiBUaGlzXG4gICAgLy8gd2lsbCBiZSBudWxsIGlmIHdlIGFyZW4ndCByZXN1bWluZyBhbiB1cGxvYWQuXG4gICAgY29uc3Qgb2xkUGFydHM6IFJlY29yZDxudW1iZXIsIFBhcnQ+ID0ge31cblxuICAgIC8vIEtlZXAgdHJhY2sgb2YgdGhlIGV0YWdzIGZvciBhZ2dyZWdhdGluZyB0aGUgY2h1bmtzIHRvZ2V0aGVyIGxhdGVyLiBFYWNoXG4gICAgLy8gZXRhZyByZXByZXNlbnRzIGEgc2luZ2xlIGNodW5rIG9mIHRoZSBmaWxlLlxuICAgIGNvbnN0IGVUYWdzOiBQYXJ0W10gPSBbXVxuXG4gICAgY29uc3QgcHJldmlvdXNVcGxvYWRJZCA9IGF3YWl0IHRoaXMuZmluZFVwbG9hZElkKGJ1Y2tldE5hbWUsIG9iamVjdE5hbWUpXG4gICAgbGV0IHVwbG9hZElkOiBzdHJpbmdcbiAgICBpZiAoIXByZXZpb3VzVXBsb2FkSWQpIHtcbiAgICAgIHVwbG9hZElkID0gYXdhaXQgdGhpcy5pbml0aWF0ZU5ld011bHRpcGFydFVwbG9hZChidWNrZXROYW1lLCBvYmplY3ROYW1lLCBoZWFkZXJzKVxuICAgIH0gZWxzZSB7XG4gICAgICB1cGxvYWRJZCA9IHByZXZpb3VzVXBsb2FkSWRcbiAgICAgIGNvbnN0IG9sZFRhZ3MgPSBhd2FpdCB0aGlzLmxpc3RQYXJ0cyhidWNrZXROYW1lLCBvYmplY3ROYW1lLCBwcmV2aW91c1VwbG9hZElkKVxuICAgICAgb2xkVGFncy5mb3JFYWNoKChlKSA9PiB7XG4gICAgICAgIG9sZFBhcnRzW2UucGFydF0gPSBlXG4gICAgICB9KVxuICAgIH1cblxuICAgIGNvbnN0IGNodW5raWVyID0gbmV3IEJsb2NrU3RyZWFtMih7IHNpemU6IHBhcnRTaXplLCB6ZXJvUGFkZGluZzogZmFsc2UgfSlcblxuICAgIC8vIGVzbGludC1kaXNhYmxlLW5leHQtbGluZSBAdHlwZXNjcmlwdC1lc2xpbnQvbm8tdW51c2VkLXZhcnNcbiAgICBjb25zdCBbXywgb10gPSBhd2FpdCBQcm9taXNlLmFsbChbXG4gICAgICBuZXcgUHJvbWlzZSgocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XG4gICAgICAgIGJvZHkucGlwZShjaHVua2llcikub24oJ2Vycm9yJywgcmVqZWN0KVxuICAgICAgICBjaHVua2llci5vbignZW5kJywgcmVzb2x2ZSkub24oJ2Vycm9yJywgcmVqZWN0KVxuICAgICAgfSksXG4gICAgICAoYXN5bmMgKCkgPT4ge1xuICAgICAgICBsZXQgcGFydE51bWJlciA9IDFcblxuICAgICAgICBmb3IgYXdhaXQgKGNvbnN0IGNodW5rIG9mIGNodW5raWVyKSB7XG4gICAgICAgICAgY29uc3QgbWQ1ID0gY3J5cHRvLmNyZWF0ZUhhc2goJ21kNScpLnVwZGF0ZShjaHVuaykuZGlnZXN0KClcblxuICAgICAgICAgIGNvbnN0IG9sZFBhcnQgPSBvbGRQYXJ0c1twYXJ0TnVtYmVyXVxuICAgICAgICAgIGlmIChvbGRQYXJ0KSB7XG4gICAgICAgICAgICBpZiAob2xkUGFydC5ldGFnID09PSBtZDUudG9TdHJpbmcoJ2hleCcpKSB7XG4gICAgICAgICAgICAgIGVUYWdzLnB1c2goeyBwYXJ0OiBwYXJ0TnVtYmVyLCBldGFnOiBvbGRQYXJ0LmV0YWcgfSlcbiAgICAgICAgICAgICAgcGFydE51bWJlcisrXG4gICAgICAgICAgICAgIGNvbnRpbnVlXG4gICAgICAgICAgICB9XG4gICAgICAgICAgfVxuXG4gICAgICAgICAgcGFydE51bWJlcisrXG5cbiAgICAgICAgICAvLyBub3cgc3RhcnQgdG8gdXBsb2FkIG1pc3NpbmcgcGFydFxuICAgICAgICAgIGNvbnN0IG9wdGlvbnM6IFJlcXVlc3RPcHRpb24gPSB7XG4gICAgICAgICAgICBtZXRob2Q6ICdQVVQnLFxuICAgICAgICAgICAgcXVlcnk6IHFzLnN0cmluZ2lmeSh7IHBhcnROdW1iZXIsIHVwbG9hZElkIH0pLFxuICAgICAgICAgICAgaGVhZGVyczoge1xuICAgICAgICAgICAgICAnQ29udGVudC1MZW5ndGgnOiBjaHVuay5sZW5ndGgsXG4gICAgICAgICAgICAgICdDb250ZW50LU1ENSc6IG1kNS50b1N0cmluZygnYmFzZTY0JyksXG4gICAgICAgICAgICB9LFxuICAgICAgICAgICAgYnVja2V0TmFtZSxcbiAgICAgICAgICAgIG9iamVjdE5hbWUsXG4gICAgICAgICAgfVxuXG4gICAgICAgICAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCB0aGlzLm1ha2VSZXF1ZXN0QXN5bmNPbWl0KG9wdGlvbnMsIGNodW5rKVxuXG4gICAgICAgICAgbGV0IGV0YWcgPSByZXNwb25zZS5oZWFkZXJzLmV0YWdcbiAgICAgICAgICBpZiAoZXRhZykge1xuICAgICAgICAgICAgZXRhZyA9IGV0YWcucmVwbGFjZSgvXlwiLywgJycpLnJlcGxhY2UoL1wiJC8sICcnKVxuICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBldGFnID0gJydcbiAgICAgICAgICB9XG5cbiAgICAgICAgICBlVGFncy5wdXNoKHsgcGFydDogcGFydE51bWJlciwgZXRhZyB9KVxuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIGF3YWl0IHRoaXMuY29tcGxldGVNdWx0aXBhcnRVcGxvYWQoYnVja2V0TmFtZSwgb2JqZWN0TmFtZSwgdXBsb2FkSWQsIGVUYWdzKVxuICAgICAgfSkoKSxcbiAgICBdKVxuXG4gICAgcmV0dXJuIG9cbiAgfVxuXG4gIGFzeW5jIHJlbW92ZUJ1Y2tldFJlcGxpY2F0aW9uKGJ1Y2tldE5hbWU6IHN0cmluZyk6IFByb21pc2U8dm9pZD5cbiAgcmVtb3ZlQnVja2V0UmVwbGljYXRpb24oYnVja2V0TmFtZTogc3RyaW5nLCBjYWxsYmFjazogTm9SZXN1bHRDYWxsYmFjayk6IHZvaWRcbiAgYXN5bmMgcmVtb3ZlQnVja2V0UmVwbGljYXRpb24oYnVja2V0TmFtZTogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgaWYgKCFpc1ZhbGlkQnVja2V0TmFtZShidWNrZXROYW1lKSkge1xuICAgICAgdGhyb3cgbmV3IGVycm9ycy5JbnZhbGlkQnVja2V0TmFtZUVycm9yKCdJbnZhbGlkIGJ1Y2tldCBuYW1lOiAnICsgYnVja2V0TmFtZSlcbiAgICB9XG4gICAgY29uc3QgbWV0aG9kID0gJ0RFTEVURSdcbiAgICBjb25zdCBxdWVyeSA9ICdyZXBsaWNhdGlvbidcbiAgICBhd2FpdCB0aGlzLm1ha2VSZXF1ZXN0QXN5bmNPbWl0KHsgbWV0aG9kLCBidWNrZXROYW1lLCBxdWVyeSB9LCAnJywgWzIwMCwgMjA0XSwgJycpXG4gIH1cblxuICBzZXRCdWNrZXRSZXBsaWNhdGlvbihidWNrZXROYW1lOiBzdHJpbmcsIHJlcGxpY2F0aW9uQ29uZmlnOiBSZXBsaWNhdGlvbkNvbmZpZ09wdHMpOiB2b2lkXG4gIGFzeW5jIHNldEJ1Y2tldFJlcGxpY2F0aW9uKGJ1Y2tldE5hbWU6IHN0cmluZywgcmVwbGljYXRpb25Db25maWc6IFJlcGxpY2F0aW9uQ29uZmlnT3B0cyk6IFByb21pc2U8dm9pZD5cbiAgYXN5bmMgc2V0QnVja2V0UmVwbGljYXRpb24oYnVja2V0TmFtZTogc3RyaW5nLCByZXBsaWNhdGlvbkNvbmZpZzogUmVwbGljYXRpb25Db25maWdPcHRzKSB7XG4gICAgaWYgKCFpc1ZhbGlkQnVja2V0TmFtZShidWNrZXROYW1lKSkge1xuICAgICAgdGhyb3cgbmV3IGVycm9ycy5JbnZhbGlkQnVja2V0TmFtZUVycm9yKCdJbnZhbGlkIGJ1Y2tldCBuYW1lOiAnICsgYnVja2V0TmFtZSlcbiAgICB9XG4gICAgaWYgKCFpc09iamVjdChyZXBsaWNhdGlvbkNvbmZpZykpIHtcbiAgICAgIHRocm93IG5ldyBlcnJvcnMuSW52YWxpZEFyZ3VtZW50RXJyb3IoJ3JlcGxpY2F0aW9uQ29uZmlnIHNob3VsZCBiZSBvZiB0eXBlIFwib2JqZWN0XCInKVxuICAgIH0gZWxzZSB7XG4gICAgICBpZiAoXy5pc0VtcHR5KHJlcGxpY2F0aW9uQ29uZmlnLnJvbGUpKSB7XG4gICAgICAgIHRocm93IG5ldyBlcnJvcnMuSW52YWxpZEFyZ3VtZW50RXJyb3IoJ1JvbGUgY2Fubm90IGJlIGVtcHR5JylcbiAgICAgIH0gZWxzZSBpZiAocmVwbGljYXRpb25Db25maWcucm9sZSAmJiAhaXNTdHJpbmcocmVwbGljYXRpb25Db25maWcucm9sZSkpIHtcbiAgICAgICAgdGhyb3cgbmV3IGVycm9ycy5JbnZhbGlkQXJndW1lbnRFcnJvcignSW52YWxpZCB2YWx1ZSBmb3Igcm9sZScsIHJlcGxpY2F0aW9uQ29uZmlnLnJvbGUpXG4gICAgICB9XG4gICAgICBpZiAoXy5pc0VtcHR5KHJlcGxpY2F0aW9uQ29uZmlnLnJ1bGVzKSkge1xuICAgICAgICB0aHJvdyBuZXcgZXJyb3JzLkludmFsaWRBcmd1bWVudEVycm9yKCdNaW5pbXVtIG9uZSByZXBsaWNhdGlvbiBydWxlIG11c3QgYmUgc3BlY2lmaWVkJylcbiAgICAgIH1cbiAgICB9XG4gICAgY29uc3QgbWV0aG9kID0gJ1BVVCdcbiAgICBjb25zdCBxdWVyeSA9ICdyZXBsaWNhdGlvbidcbiAgICBjb25zdCBoZWFkZXJzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0ge31cblxuICAgIGNvbnN0IHJlcGxpY2F0aW9uUGFyYW1zQ29uZmlnID0ge1xuICAgICAgUmVwbGljYXRpb25Db25maWd1cmF0aW9uOiB7XG4gICAgICAgIFJvbGU6IHJlcGxpY2F0aW9uQ29uZmlnLnJvbGUsXG4gICAgICAgIFJ1bGU6IHJlcGxpY2F0aW9uQ29uZmlnLnJ1bGVzLFxuICAgICAgfSxcbiAgICB9XG5cbiAgICBjb25zdCBidWlsZGVyID0gbmV3IHhtbDJqcy5CdWlsZGVyKHsgcmVuZGVyT3B0czogeyBwcmV0dHk6IGZhbHNlIH0sIGhlYWRsZXNzOiB0cnVlIH0pXG4gICAgY29uc3QgcGF5bG9hZCA9IGJ1aWxkZXIuYnVpbGRPYmplY3QocmVwbGljYXRpb25QYXJhbXNDb25maWcpXG4gICAgaGVhZGVyc1snQ29udGVudC1NRDUnXSA9IHRvTWQ1KHBheWxvYWQpXG4gICAgYXdhaXQgdGhpcy5tYWtlUmVxdWVzdEFzeW5jT21pdCh7IG1ldGhvZCwgYnVja2V0TmFtZSwgcXVlcnksIGhlYWRlcnMgfSwgcGF5bG9hZClcbiAgfVxuXG4gIGdldEJ1Y2tldFJlcGxpY2F0aW9uKGJ1Y2tldE5hbWU6IHN0cmluZyk6IHZvaWRcbiAgYXN5bmMgZ2V0QnVja2V0UmVwbGljYXRpb24oYnVja2V0TmFtZTogc3RyaW5nKTogUHJvbWlzZTxSZXBsaWNhdGlvbkNvbmZpZz5cbiAgYXN5bmMgZ2V0QnVja2V0UmVwbGljYXRpb24oYnVja2V0TmFtZTogc3RyaW5nKSB7XG4gICAgaWYgKCFpc1ZhbGlkQnVja2V0TmFtZShidWNrZXROYW1lKSkge1xuICAgICAgdGhyb3cgbmV3IGVycm9ycy5JbnZhbGlkQnVja2V0TmFtZUVycm9yKCdJbnZhbGlkIGJ1Y2tldCBuYW1lOiAnICsgYnVja2V0TmFtZSlcbiAgICB9XG4gICAgY29uc3QgbWV0aG9kID0gJ0dFVCdcbiAgICBjb25zdCBxdWVyeSA9ICdyZXBsaWNhdGlvbidcblxuICAgIGNvbnN0IGh0dHBSZXMgPSBhd2FpdCB0aGlzLm1ha2VSZXF1ZXN0QXN5bmMoeyBtZXRob2QsIGJ1Y2tldE5hbWUsIHF1ZXJ5IH0sICcnLCBbMjAwLCAyMDRdKVxuICAgIGNvbnN0IHhtbFJlc3VsdCA9IGF3YWl0IHJlYWRBc1N0cmluZyhodHRwUmVzKVxuICAgIHJldHVybiB4bWxQYXJzZXJzLnBhcnNlUmVwbGljYXRpb25Db25maWcoeG1sUmVzdWx0KVxuICB9XG5cbiAgZ2V0T2JqZWN0TGVnYWxIb2xkKFxuICAgIGJ1Y2tldE5hbWU6IHN0cmluZyxcbiAgICBvYmplY3ROYW1lOiBzdHJpbmcsXG4gICAgZ2V0T3B0cz86IEdldE9iamVjdExlZ2FsSG9sZE9wdGlvbnMsXG4gICAgY2FsbGJhY2s/OiBSZXN1bHRDYWxsYmFjazxMRUdBTF9IT0xEX1NUQVRVUz4sXG4gICk6IFByb21pc2U8TEVHQUxfSE9MRF9TVEFUVVM+XG4gIGFzeW5jIGdldE9iamVjdExlZ2FsSG9sZChcbiAgICBidWNrZXROYW1lOiBzdHJpbmcsXG4gICAgb2JqZWN0TmFtZTogc3RyaW5nLFxuICAgIGdldE9wdHM/OiBHZXRPYmplY3RMZWdhbEhvbGRPcHRpb25zLFxuICApOiBQcm9taXNlPExFR0FMX0hPTERfU1RBVFVTPiB7XG4gICAgaWYgKCFpc1ZhbGlkQnVja2V0TmFtZShidWNrZXROYW1lKSkge1xuICAgICAgdGhyb3cgbmV3IGVycm9ycy5JbnZhbGlkQnVja2V0TmFtZUVycm9yKCdJbnZhbGlkIGJ1Y2tldCBuYW1lOiAnICsgYnVja2V0TmFtZSlcbiAgICB9XG4gICAgaWYgKCFpc1ZhbGlkT2JqZWN0TmFtZShvYmplY3ROYW1lKSkge1xuICAgICAgdGhyb3cgbmV3IGVycm9ycy5JbnZhbGlkT2JqZWN0TmFtZUVycm9yKGBJbnZhbGlkIG9iamVjdCBuYW1lOiAke29iamVjdE5hbWV9YClcbiAgICB9XG5cbiAgICBpZiAoZ2V0T3B0cykge1xuICAgICAgaWYgKCFpc09iamVjdChnZXRPcHRzKSkge1xuICAgICAgICB0aHJvdyBuZXcgVHlwZUVycm9yKCdnZXRPcHRzIHNob3VsZCBiZSBvZiB0eXBlIFwiT2JqZWN0XCInKVxuICAgICAgfSBlbHNlIGlmIChPYmplY3Qua2V5cyhnZXRPcHRzKS5sZW5ndGggPiAwICYmIGdldE9wdHMudmVyc2lvbklkICYmICFpc1N0cmluZyhnZXRPcHRzLnZlcnNpb25JZCkpIHtcbiAgICAgICAgdGhyb3cgbmV3IFR5cGVFcnJvcigndmVyc2lvbklkIHNob3VsZCBiZSBvZiB0eXBlIHN0cmluZy46JywgZ2V0T3B0cy52ZXJzaW9uSWQpXG4gICAgICB9XG4gICAgfVxuXG4gICAgY29uc3QgbWV0aG9kID0gJ0dFVCdcbiAgICBsZXQgcXVlcnkgPSAnbGVnYWwtaG9sZCdcblxuICAgIGlmIChnZXRPcHRzPy52ZXJzaW9uSWQpIHtcbiAgICAgIHF1ZXJ5ICs9IGAmdmVyc2lvbklkPSR7Z2V0T3B0cy52ZXJzaW9uSWR9YFxuICAgIH1cblxuICAgIGNvbnN0IGh0dHBSZXMgPSBhd2FpdCB0aGlzLm1ha2VSZXF1ZXN0QXN5bmMoeyBtZXRob2QsIGJ1Y2tldE5hbWUsIG9iamVjdE5hbWUsIHF1ZXJ5IH0sICcnLCBbMjAwXSlcbiAgICBjb25zdCBzdHJSZXMgPSBhd2FpdCByZWFkQXNTdHJpbmcoaHR0cFJlcylcbiAgICByZXR1cm4gcGFyc2VPYmplY3RMZWdhbEhvbGRDb25maWcoc3RyUmVzKVxuICB9XG5cbiAgc2V0T2JqZWN0TGVnYWxIb2xkKGJ1Y2tldE5hbWU6IHN0cmluZywgb2JqZWN0TmFtZTogc3RyaW5nLCBzZXRPcHRzPzogUHV0T2JqZWN0TGVnYWxIb2xkT3B0aW9ucyk6IHZvaWRcbiAgYXN5bmMgc2V0T2JqZWN0TGVnYWxIb2xkKFxuICAgIGJ1Y2tldE5hbWU6IHN0cmluZyxcbiAgICBvYmplY3ROYW1lOiBzdHJpbmcsXG4gICAgc2V0T3B0cyA9IHtcbiAgICAgIHN0YXR1czogTEVHQUxfSE9MRF9TVEFUVVMuRU5BQkxFRCxcbiAgICB9IGFzIFB1dE9iamVjdExlZ2FsSG9sZE9wdGlvbnMsXG4gICk6IFByb21pc2U8dm9pZD4ge1xuICAgIGlmICghaXNWYWxpZEJ1Y2tldE5hbWUoYnVja2V0TmFtZSkpIHtcbiAgICAgIHRocm93IG5ldyBlcnJvcnMuSW52YWxpZEJ1Y2tldE5hbWVFcnJvcignSW52YWxpZCBidWNrZXQgbmFtZTogJyArIGJ1Y2tldE5hbWUpXG4gICAgfVxuICAgIGlmICghaXNWYWxpZE9iamVjdE5hbWUob2JqZWN0TmFtZSkpIHtcbiAgICAgIHRocm93IG5ldyBlcnJvcnMuSW52YWxpZE9iamVjdE5hbWVFcnJvcihgSW52YWxpZCBvYmplY3QgbmFtZTogJHtvYmplY3ROYW1lfWApXG4gICAgfVxuXG4gICAgaWYgKCFpc09iamVjdChzZXRPcHRzKSkge1xuICAgICAgdGhyb3cgbmV3IFR5cGVFcnJvcignc2V0T3B0cyBzaG91bGQgYmUgb2YgdHlwZSBcIk9iamVjdFwiJylcbiAgICB9IGVsc2Uge1xuICAgICAgaWYgKCFbTEVHQUxfSE9MRF9TVEFUVVMuRU5BQkxFRCwgTEVHQUxfSE9MRF9TVEFUVVMuRElTQUJMRURdLmluY2x1ZGVzKHNldE9wdHM/LnN0YXR1cykpIHtcbiAgICAgICAgdGhyb3cgbmV3IFR5cGVFcnJvcignSW52YWxpZCBzdGF0dXM6ICcgKyBzZXRPcHRzLnN0YXR1cylcbiAgICAgIH1cbiAgICAgIGlmIChzZXRPcHRzLnZlcnNpb25JZCAmJiAhc2V0T3B0cy52ZXJzaW9uSWQubGVuZ3RoKSB7XG4gICAgICAgIHRocm93IG5ldyBUeXBlRXJyb3IoJ3ZlcnNpb25JZCBzaG91bGQgYmUgb2YgdHlwZSBzdHJpbmcuOicgKyBzZXRPcHRzLnZlcnNpb25JZClcbiAgICAgIH1cbiAgICB9XG5cbiAgICBjb25zdCBtZXRob2QgPSAnUFVUJ1xuICAgIGxldCBxdWVyeSA9ICdsZWdhbC1ob2xkJ1xuXG4gICAgaWYgKHNldE9wdHMudmVyc2lvbklkKSB7XG4gICAgICBxdWVyeSArPSBgJnZlcnNpb25JZD0ke3NldE9wdHMudmVyc2lvbklkfWBcbiAgICB9XG5cbiAgICBjb25zdCBjb25maWcgPSB7XG4gICAgICBTdGF0dXM6IHNldE9wdHMuc3RhdHVzLFxuICAgIH1cblxuICAgIGNvbnN0IGJ1aWxkZXIgPSBuZXcgeG1sMmpzLkJ1aWxkZXIoeyByb290TmFtZTogJ0xlZ2FsSG9sZCcsIHJlbmRlck9wdHM6IHsgcHJldHR5OiBmYWxzZSB9LCBoZWFkbGVzczogdHJ1ZSB9KVxuICAgIGNvbnN0IHBheWxvYWQgPSBidWlsZGVyLmJ1aWxkT2JqZWN0KGNvbmZpZylcbiAgICBjb25zdCBoZWFkZXJzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0ge31cbiAgICBoZWFkZXJzWydDb250ZW50LU1ENSddID0gdG9NZDUocGF5bG9hZClcblxuICAgIGF3YWl0IHRoaXMubWFrZVJlcXVlc3RBc3luY09taXQoeyBtZXRob2QsIGJ1Y2tldE5hbWUsIG9iamVjdE5hbWUsIHF1ZXJ5LCBoZWFkZXJzIH0sIHBheWxvYWQpXG4gIH1cblxuICAvKipcbiAgICogR2V0IFRhZ3MgYXNzb2NpYXRlZCB3aXRoIGEgQnVja2V0XG4gICAqL1xuICBhc3luYyBnZXRCdWNrZXRUYWdnaW5nKGJ1Y2tldE5hbWU6IHN0cmluZyk6IFByb21pc2U8VGFnW10+IHtcbiAgICBpZiAoIWlzVmFsaWRCdWNrZXROYW1lKGJ1Y2tldE5hbWUpKSB7XG4gICAgICB0aHJvdyBuZXcgZXJyb3JzLkludmFsaWRCdWNrZXROYW1lRXJyb3IoYEludmFsaWQgYnVja2V0IG5hbWU6ICR7YnVja2V0TmFtZX1gKVxuICAgIH1cblxuICAgIGNvbnN0IG1ldGhvZCA9ICdHRVQnXG4gICAgY29uc3QgcXVlcnkgPSAndGFnZ2luZydcbiAgICBjb25zdCByZXF1ZXN0T3B0aW9ucyA9IHsgbWV0aG9kLCBidWNrZXROYW1lLCBxdWVyeSB9XG5cbiAgICBjb25zdCByZXNwb25zZSA9IGF3YWl0IHRoaXMubWFrZVJlcXVlc3RBc3luYyhyZXF1ZXN0T3B0aW9ucylcbiAgICBjb25zdCBib2R5ID0gYXdhaXQgcmVhZEFzU3RyaW5nKHJlc3BvbnNlKVxuICAgIHJldHVybiB4bWxQYXJzZXJzLnBhcnNlVGFnZ2luZyhib2R5KVxuICB9XG5cbiAgLyoqXG4gICAqICBHZXQgdGhlIHRhZ3MgYXNzb2NpYXRlZCB3aXRoIGEgYnVja2V0IE9SIGFuIG9iamVjdFxuICAgKi9cbiAgYXN5bmMgZ2V0T2JqZWN0VGFnZ2luZyhidWNrZXROYW1lOiBzdHJpbmcsIG9iamVjdE5hbWU6IHN0cmluZywgZ2V0T3B0cz86IEdldE9iamVjdE9wdHMpOiBQcm9taXNlPFRhZ1tdPiB7XG4gICAgY29uc3QgbWV0aG9kID0gJ0dFVCdcbiAgICBsZXQgcXVlcnkgPSAndGFnZ2luZydcblxuICAgIGlmICghaXNWYWxpZEJ1Y2tldE5hbWUoYnVja2V0TmFtZSkpIHtcbiAgICAgIHRocm93IG5ldyBlcnJvcnMuSW52YWxpZEJ1Y2tldE5hbWVFcnJvcignSW52YWxpZCBidWNrZXQgbmFtZTogJyArIGJ1Y2tldE5hbWUpXG4gICAgfVxuICAgIGlmICghaXNWYWxpZE9iamVjdE5hbWUob2JqZWN0TmFtZSkpIHtcbiAgICAgIHRocm93IG5ldyBlcnJvcnMuSW52YWxpZEJ1Y2tldE5hbWVFcnJvcignSW52YWxpZCBvYmplY3QgbmFtZTogJyArIG9iamVjdE5hbWUpXG4gICAgfVxuICAgIGlmIChnZXRPcHRzICYmICFpc09iamVjdChnZXRPcHRzKSkge1xuICAgICAgdGhyb3cgbmV3IGVycm9ycy5JbnZhbGlkQXJndW1lbnRFcnJvcignZ2V0T3B0cyBzaG91bGQgYmUgb2YgdHlwZSBcIm9iamVjdFwiJylcbiAgICB9XG5cbiAgICBpZiAoZ2V0T3B0cyAmJiBnZXRPcHRzLnZlcnNpb25JZCkge1xuICAgICAgcXVlcnkgPSBgJHtxdWVyeX0mdmVyc2lvbklkPSR7Z2V0T3B0cy52ZXJzaW9uSWR9YFxuICAgIH1cbiAgICBjb25zdCByZXF1ZXN0T3B0aW9uczogUmVxdWVzdE9wdGlvbiA9IHsgbWV0aG9kLCBidWNrZXROYW1lLCBxdWVyeSB9XG4gICAgaWYgKG9iamVjdE5hbWUpIHtcbiAgICAgIHJlcXVlc3RPcHRpb25zWydvYmplY3ROYW1lJ10gPSBvYmplY3ROYW1lXG4gICAgfVxuXG4gICAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCB0aGlzLm1ha2VSZXF1ZXN0QXN5bmMocmVxdWVzdE9wdGlvbnMpXG4gICAgY29uc3QgYm9keSA9IGF3YWl0IHJlYWRBc1N0cmluZyhyZXNwb25zZSlcbiAgICByZXR1cm4geG1sUGFyc2Vycy5wYXJzZVRhZ2dpbmcoYm9keSlcbiAgfVxuXG4gIC8qKlxuICAgKiAgU2V0IHRoZSBwb2xpY3kgb24gYSBidWNrZXQgb3IgYW4gb2JqZWN0IHByZWZpeC5cbiAgICovXG4gIGFzeW5jIHNldEJ1Y2tldFBvbGljeShidWNrZXROYW1lOiBzdHJpbmcsIHBvbGljeTogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgLy8gVmFsaWRhdGUgYXJndW1lbnRzLlxuICAgIGlmICghaXNWYWxpZEJ1Y2tldE5hbWUoYnVja2V0TmFtZSkpIHtcbiAgICAgIHRocm93IG5ldyBlcnJvcnMuSW52YWxpZEJ1Y2tldE5hbWVFcnJvcihgSW52YWxpZCBidWNrZXQgbmFtZTogJHtidWNrZXROYW1lfWApXG4gICAgfVxuICAgIGlmICghaXNTdHJpbmcocG9saWN5KSkge1xuICAgICAgdGhyb3cgbmV3IGVycm9ycy5JbnZhbGlkQnVja2V0UG9saWN5RXJyb3IoYEludmFsaWQgYnVja2V0IHBvbGljeTogJHtwb2xpY3l9IC0gbXVzdCBiZSBcInN0cmluZ1wiYClcbiAgICB9XG5cbiAgICBjb25zdCBxdWVyeSA9ICdwb2xpY3knXG5cbiAgICBsZXQgbWV0aG9kID0gJ0RFTEVURSdcbiAgICBpZiAocG9saWN5KSB7XG4gICAgICBtZXRob2QgPSAnUFVUJ1xuICAgIH1cblxuICAgIGF3YWl0IHRoaXMubWFrZVJlcXVlc3RBc3luY09taXQoeyBtZXRob2QsIGJ1Y2tldE5hbWUsIHF1ZXJ5IH0sIHBvbGljeSwgWzIwNF0sICcnKVxuICB9XG5cbiAgLyoqXG4gICAqIEdldCB0aGUgcG9saWN5IG9uIGEgYnVja2V0IG9yIGFuIG9iamVjdCBwcmVmaXguXG4gICAqL1xuICBhc3luYyBnZXRCdWNrZXRQb2xpY3koYnVja2V0TmFtZTogc3RyaW5nKTogUHJvbWlzZTxzdHJpbmc+IHtcbiAgICAvLyBWYWxpZGF0ZSBhcmd1bWVudHMuXG4gICAgaWYgKCFpc1ZhbGlkQnVja2V0TmFtZShidWNrZXROYW1lKSkge1xuICAgICAgdGhyb3cgbmV3IGVycm9ycy5JbnZhbGlkQnVja2V0TmFtZUVycm9yKGBJbnZhbGlkIGJ1Y2tldCBuYW1lOiAke2J1Y2tldE5hbWV9YClcbiAgICB9XG5cbiAgICBjb25zdCBtZXRob2QgPSAnR0VUJ1xuICAgIGNvbnN0IHF1ZXJ5ID0gJ3BvbGljeSdcbiAgICBjb25zdCByZXMgPSBhd2FpdCB0aGlzLm1ha2VSZXF1ZXN0QXN5bmMoeyBtZXRob2QsIGJ1Y2tldE5hbWUsIHF1ZXJ5IH0pXG4gICAgcmV0dXJuIGF3YWl0IHJlYWRBc1N0cmluZyhyZXMpXG4gIH1cblxuICBhc3luYyBwdXRPYmplY3RSZXRlbnRpb24oYnVja2V0TmFtZTogc3RyaW5nLCBvYmplY3ROYW1lOiBzdHJpbmcsIHJldGVudGlvbk9wdHM6IFJldGVudGlvbiA9IHt9KTogUHJvbWlzZTx2b2lkPiB7XG4gICAgaWYgKCFpc1ZhbGlkQnVja2V0TmFtZShidWNrZXROYW1lKSkge1xuICAgICAgdGhyb3cgbmV3IGVycm9ycy5JbnZhbGlkQnVja2V0TmFtZUVycm9yKGBJbnZhbGlkIGJ1Y2tldCBuYW1lOiAke2J1Y2tldE5hbWV9YClcbiAgICB9XG4gICAgaWYgKCFpc1ZhbGlkT2JqZWN0TmFtZShvYmplY3ROYW1lKSkge1xuICAgICAgdGhyb3cgbmV3IGVycm9ycy5JbnZhbGlkT2JqZWN0TmFtZUVycm9yKGBJbnZhbGlkIG9iamVjdCBuYW1lOiAke29iamVjdE5hbWV9YClcbiAgICB9XG4gICAgaWYgKCFpc09iamVjdChyZXRlbnRpb25PcHRzKSkge1xuICAgICAgdGhyb3cgbmV3IGVycm9ycy5JbnZhbGlkQXJndW1lbnRFcnJvcigncmV0ZW50aW9uT3B0cyBzaG91bGQgYmUgb2YgdHlwZSBcIm9iamVjdFwiJylcbiAgICB9IGVsc2Uge1xuICAgICAgaWYgKHJldGVudGlvbk9wdHMuZ292ZXJuYW5jZUJ5cGFzcyAmJiAhaXNCb29sZWFuKHJldGVudGlvbk9wdHMuZ292ZXJuYW5jZUJ5cGFzcykpIHtcbiAgICAgICAgdGhyb3cgbmV3IGVycm9ycy5JbnZhbGlkQXJndW1lbnRFcnJvcihgSW52YWxpZCB2YWx1ZSBmb3IgZ292ZXJuYW5jZUJ5cGFzczogJHtyZXRlbnRpb25PcHRzLmdvdmVybmFuY2VCeXBhc3N9YClcbiAgICAgIH1cbiAgICAgIGlmIChcbiAgICAgICAgcmV0ZW50aW9uT3B0cy5tb2RlICYmXG4gICAgICAgICFbUkVURU5USU9OX01PREVTLkNPTVBMSUFOQ0UsIFJFVEVOVElPTl9NT0RFUy5HT1ZFUk5BTkNFXS5pbmNsdWRlcyhyZXRlbnRpb25PcHRzLm1vZGUpXG4gICAgICApIHtcbiAgICAgICAgdGhyb3cgbmV3IGVycm9ycy5JbnZhbGlkQXJndW1lbnRFcnJvcihgSW52YWxpZCBvYmplY3QgcmV0ZW50aW9uIG1vZGU6ICR7cmV0ZW50aW9uT3B0cy5tb2RlfWApXG4gICAgICB9XG4gICAgICBpZiAocmV0ZW50aW9uT3B0cy5yZXRhaW5VbnRpbERhdGUgJiYgIWlzU3RyaW5nKHJldGVudGlvbk9wdHMucmV0YWluVW50aWxEYXRlKSkge1xuICAgICAgICB0aHJvdyBuZXcgZXJyb3JzLkludmFsaWRBcmd1bWVudEVycm9yKGBJbnZhbGlkIHZhbHVlIGZvciByZXRhaW5VbnRpbERhdGU6ICR7cmV0ZW50aW9uT3B0cy5yZXRhaW5VbnRpbERhdGV9YClcbiAgICAgIH1cbiAgICAgIGlmIChyZXRlbnRpb25PcHRzLnZlcnNpb25JZCAmJiAhaXNTdHJpbmcocmV0ZW50aW9uT3B0cy52ZXJzaW9uSWQpKSB7XG4gICAgICAgIHRocm93IG5ldyBlcnJvcnMuSW52YWxpZEFyZ3VtZW50RXJyb3IoYEludmFsaWQgdmFsdWUgZm9yIHZlcnNpb25JZDogJHtyZXRlbnRpb25PcHRzLnZlcnNpb25JZH1gKVxuICAgICAgfVxuICAgIH1cblxuICAgIGNvbnN0IG1ldGhvZCA9ICdQVVQnXG4gICAgbGV0IHF1ZXJ5ID0gJ3JldGVudGlvbidcblxuICAgIGNvbnN0IGhlYWRlcnM6IFJlcXVlc3RIZWFkZXJzID0ge31cbiAgICBpZiAocmV0ZW50aW9uT3B0cy5nb3Zlcm5hbmNlQnlwYXNzKSB7XG4gICAgICBoZWFkZXJzWydYLUFtei1CeXBhc3MtR292ZXJuYW5jZS1SZXRlbnRpb24nXSA9IHRydWVcbiAgICB9XG5cbiAgICBjb25zdCBidWlsZGVyID0gbmV3IHhtbDJqcy5CdWlsZGVyKHsgcm9vdE5hbWU6ICdSZXRlbnRpb24nLCByZW5kZXJPcHRzOiB7IHByZXR0eTogZmFsc2UgfSwgaGVhZGxlc3M6IHRydWUgfSlcbiAgICBjb25zdCBwYXJhbXM6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7fVxuXG4gICAgaWYgKHJldGVudGlvbk9wdHMubW9kZSkge1xuICAgICAgcGFyYW1zLk1vZGUgPSByZXRlbnRpb25PcHRzLm1vZGVcbiAgICB9XG4gICAgaWYgKHJldGVudGlvbk9wdHMucmV0YWluVW50aWxEYXRlKSB7XG4gICAgICBwYXJhbXMuUmV0YWluVW50aWxEYXRlID0gcmV0ZW50aW9uT3B0cy5yZXRhaW5VbnRpbERhdGVcbiAgICB9XG4gICAgaWYgKHJldGVudGlvbk9wdHMudmVyc2lvbklkKSB7XG4gICAgICBxdWVyeSArPSBgJnZlcnNpb25JZD0ke3JldGVudGlvbk9wdHMudmVyc2lvbklkfWBcbiAgICB9XG5cbiAgICBjb25zdCBwYXlsb2FkID0gYnVpbGRlci5idWlsZE9iamVjdChwYXJhbXMpXG5cbiAgICBoZWFkZXJzWydDb250ZW50LU1ENSddID0gdG9NZDUocGF5bG9hZClcbiAgICBhd2FpdCB0aGlzLm1ha2VSZXF1ZXN0QXN5bmNPbWl0KHsgbWV0aG9kLCBidWNrZXROYW1lLCBvYmplY3ROYW1lLCBxdWVyeSwgaGVhZGVycyB9LCBwYXlsb2FkLCBbMjAwLCAyMDRdKVxuICB9XG5cbiAgZ2V0T2JqZWN0TG9ja0NvbmZpZyhidWNrZXROYW1lOiBzdHJpbmcsIGNhbGxiYWNrOiBSZXN1bHRDYWxsYmFjazxPYmplY3RMb2NrSW5mbz4pOiB2b2lkXG4gIGdldE9iamVjdExvY2tDb25maWcoYnVja2V0TmFtZTogc3RyaW5nKTogdm9pZFxuICBhc3luYyBnZXRPYmplY3RMb2NrQ29uZmlnKGJ1Y2tldE5hbWU6IHN0cmluZyk6IFByb21pc2U8T2JqZWN0TG9ja0luZm8+XG4gIGFzeW5jIGdldE9iamVjdExvY2tDb25maWcoYnVja2V0TmFtZTogc3RyaW5nKSB7XG4gICAgaWYgKCFpc1ZhbGlkQnVja2V0TmFtZShidWNrZXROYW1lKSkge1xuICAgICAgdGhyb3cgbmV3IGVycm9ycy5JbnZhbGlkQnVja2V0TmFtZUVycm9yKCdJbnZhbGlkIGJ1Y2tldCBuYW1lOiAnICsgYnVja2V0TmFtZSlcbiAgICB9XG4gICAgY29uc3QgbWV0aG9kID0gJ0dFVCdcbiAgICBjb25zdCBxdWVyeSA9ICdvYmplY3QtbG9jaydcblxuICAgIGNvbnN0IGh0dHBSZXMgPSBhd2FpdCB0aGlzLm1ha2VSZXF1ZXN0QXN5bmMoeyBtZXRob2QsIGJ1Y2tldE5hbWUsIHF1ZXJ5IH0pXG4gICAgY29uc3QgeG1sUmVzdWx0ID0gYXdhaXQgcmVhZEFzU3RyaW5nKGh0dHBSZXMpXG4gICAgcmV0dXJuIHhtbFBhcnNlcnMucGFyc2VPYmplY3RMb2NrQ29uZmlnKHhtbFJlc3VsdClcbiAgfVxuXG4gIHNldE9iamVjdExvY2tDb25maWcoYnVja2V0TmFtZTogc3RyaW5nLCBsb2NrQ29uZmlnT3B0czogT21pdDxPYmplY3RMb2NrSW5mbywgJ29iamVjdExvY2tFbmFibGVkJz4pOiB2b2lkXG4gIGFzeW5jIHNldE9iamVjdExvY2tDb25maWcoXG4gICAgYnVja2V0TmFtZTogc3RyaW5nLFxuICAgIGxvY2tDb25maWdPcHRzOiBPbWl0PE9iamVjdExvY2tJbmZvLCAnb2JqZWN0TG9ja0VuYWJsZWQnPixcbiAgKTogUHJvbWlzZTx2b2lkPlxuICBhc3luYyBzZXRPYmplY3RMb2NrQ29uZmlnKGJ1Y2tldE5hbWU6IHN0cmluZywgbG9ja0NvbmZpZ09wdHM6IE9taXQ8T2JqZWN0TG9ja0luZm8sICdvYmplY3RMb2NrRW5hYmxlZCc+KSB7XG4gICAgY29uc3QgcmV0ZW50aW9uTW9kZXMgPSBbUkVURU5USU9OX01PREVTLkNPTVBMSUFOQ0UsIFJFVEVOVElPTl9NT0RFUy5HT1ZFUk5BTkNFXVxuICAgIGNvbnN0IHZhbGlkVW5pdHMgPSBbUkVURU5USU9OX1ZBTElESVRZX1VOSVRTLkRBWVMsIFJFVEVOVElPTl9WQUxJRElUWV9VTklUUy5ZRUFSU11cblxuICAgIGlmICghaXNWYWxpZEJ1Y2tldE5hbWUoYnVja2V0TmFtZSkpIHtcbiAgICAgIHRocm93IG5ldyBlcnJvcnMuSW52YWxpZEJ1Y2tldE5hbWVFcnJvcignSW52YWxpZCBidWNrZXQgbmFtZTogJyArIGJ1Y2tldE5hbWUpXG4gICAgfVxuXG4gICAgaWYgKGxvY2tDb25maWdPcHRzLm1vZGUgJiYgIXJldGVudGlvbk1vZGVzLmluY2x1ZGVzKGxvY2tDb25maWdPcHRzLm1vZGUpKSB7XG4gICAgICB0aHJvdyBuZXcgVHlwZUVycm9yKGBsb2NrQ29uZmlnT3B0cy5tb2RlIHNob3VsZCBiZSBvbmUgb2YgJHtyZXRlbnRpb25Nb2Rlc31gKVxuICAgIH1cbiAgICBpZiAobG9ja0NvbmZpZ09wdHMudW5pdCAmJiAhdmFsaWRVbml0cy5pbmNsdWRlcyhsb2NrQ29uZmlnT3B0cy51bml0KSkge1xuICAgICAgdGhyb3cgbmV3IFR5cGVFcnJvcihgbG9ja0NvbmZpZ09wdHMudW5pdCBzaG91bGQgYmUgb25lIG9mICR7dmFsaWRVbml0c31gKVxuICAgIH1cbiAgICBpZiAobG9ja0NvbmZpZ09wdHMudmFsaWRpdHkgJiYgIWlzTnVtYmVyKGxvY2tDb25maWdPcHRzLnZhbGlkaXR5KSkge1xuICAgICAgdGhyb3cgbmV3IFR5cGVFcnJvcihgbG9ja0NvbmZpZ09wdHMudmFsaWRpdHkgc2hvdWxkIGJlIGEgbnVtYmVyYClcbiAgICB9XG5cbiAgICBjb25zdCBtZXRob2QgPSAnUFVUJ1xuICAgIGNvbnN0IHF1ZXJ5ID0gJ29iamVjdC1sb2NrJ1xuXG4gICAgY29uc3QgY29uZmlnOiBPYmplY3RMb2NrQ29uZmlnUGFyYW0gPSB7XG4gICAgICBPYmplY3RMb2NrRW5hYmxlZDogJ0VuYWJsZWQnLFxuICAgIH1cbiAgICBjb25zdCBjb25maWdLZXlzID0gT2JqZWN0LmtleXMobG9ja0NvbmZpZ09wdHMpXG5cbiAgICBjb25zdCBpc0FsbEtleXNTZXQgPSBbJ3VuaXQnLCAnbW9kZScsICd2YWxpZGl0eSddLmV2ZXJ5KChsY2spID0+IGNvbmZpZ0tleXMuaW5jbHVkZXMobGNrKSlcbiAgICAvLyBDaGVjayBpZiBrZXlzIGFyZSBwcmVzZW50IGFuZCBhbGwga2V5cyBhcmUgcHJlc2VudC5cbiAgICBpZiAoY29uZmlnS2V5cy5sZW5ndGggPiAwKSB7XG4gICAgICBpZiAoIWlzQWxsS2V5c1NldCkge1xuICAgICAgICB0aHJvdyBuZXcgVHlwZUVycm9yKFxuICAgICAgICAgIGBsb2NrQ29uZmlnT3B0cy5tb2RlLGxvY2tDb25maWdPcHRzLnVuaXQsbG9ja0NvbmZpZ09wdHMudmFsaWRpdHkgYWxsIHRoZSBwcm9wZXJ0aWVzIHNob3VsZCBiZSBzcGVjaWZpZWQuYCxcbiAgICAgICAgKVxuICAgICAgfSBlbHNlIHtcbiAgICAgICAgY29uZmlnLlJ1bGUgPSB7XG4gICAgICAgICAgRGVmYXVsdFJldGVudGlvbjoge30sXG4gICAgICAgIH1cbiAgICAgICAgaWYgKGxvY2tDb25maWdPcHRzLm1vZGUpIHtcbiAgICAgICAgICBjb25maWcuUnVsZS5EZWZhdWx0UmV0ZW50aW9uLk1vZGUgPSBsb2NrQ29uZmlnT3B0cy5tb2RlXG4gICAgICAgIH1cbiAgICAgICAgaWYgKGxvY2tDb25maWdPcHRzLnVuaXQgPT09IFJFVEVOVElPTl9WQUxJRElUWV9VTklUUy5EQVlTKSB7XG4gICAgICAgICAgY29uZmlnLlJ1bGUuRGVmYXVsdFJldGVudGlvbi5EYXlzID0gbG9ja0NvbmZpZ09wdHMudmFsaWRpdHlcbiAgICAgICAgfSBlbHNlIGlmIChsb2NrQ29uZmlnT3B0cy51bml0ID09PSBSRVRFTlRJT05fVkFMSURJVFlfVU5JVFMuWUVBUlMpIHtcbiAgICAgICAgICBjb25maWcuUnVsZS5EZWZhdWx0UmV0ZW50aW9uLlllYXJzID0gbG9ja0NvbmZpZ09wdHMudmFsaWRpdHlcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cblxuICAgIGNvbnN0IGJ1aWxkZXIgPSBuZXcgeG1sMmpzLkJ1aWxkZXIoe1xuICAgICAgcm9vdE5hbWU6ICdPYmplY3RMb2NrQ29uZmlndXJhdGlvbicsXG4gICAgICByZW5kZXJPcHRzOiB7IHByZXR0eTogZmFsc2UgfSxcbiAgICAgIGhlYWRsZXNzOiB0cnVlLFxuICAgIH0pXG4gICAgY29uc3QgcGF5bG9hZCA9IGJ1aWxkZXIuYnVpbGRPYmplY3QoY29uZmlnKVxuXG4gICAgY29uc3QgaGVhZGVyczogUmVxdWVzdEhlYWRlcnMgPSB7fVxuICAgIGhlYWRlcnNbJ0NvbnRlbnQtTUQ1J10gPSB0b01kNShwYXlsb2FkKVxuXG4gICAgYXdhaXQgdGhpcy5tYWtlUmVxdWVzdEFzeW5jT21pdCh7IG1ldGhvZCwgYnVja2V0TmFtZSwgcXVlcnksIGhlYWRlcnMgfSwgcGF5bG9hZClcbiAgfVxuXG4gIGFzeW5jIGdldEJ1Y2tldFZlcnNpb25pbmcoYnVja2V0TmFtZTogc3RyaW5nKTogUHJvbWlzZTxCdWNrZXRWZXJzaW9uaW5nQ29uZmlndXJhdGlvbj4ge1xuICAgIGlmICghaXNWYWxpZEJ1Y2tldE5hbWUoYnVja2V0TmFtZSkpIHtcbiAgICAgIHRocm93IG5ldyBlcnJvcnMuSW52YWxpZEJ1Y2tldE5hbWVFcnJvcignSW52YWxpZCBidWNrZXQgbmFtZTogJyArIGJ1Y2tldE5hbWUpXG4gICAgfVxuICAgIGNvbnN0IG1ldGhvZCA9ICdHRVQnXG4gICAgY29uc3QgcXVlcnkgPSAndmVyc2lvbmluZydcblxuICAgIGNvbnN0IGh0dHBSZXMgPSBhd2FpdCB0aGlzLm1ha2VSZXF1ZXN0QXN5bmMoeyBtZXRob2QsIGJ1Y2tldE5hbWUsIHF1ZXJ5IH0pXG4gICAgY29uc3QgeG1sUmVzdWx0ID0gYXdhaXQgcmVhZEFzU3RyaW5nKGh0dHBSZXMpXG4gICAgcmV0dXJuIGF3YWl0IHhtbFBhcnNlcnMucGFyc2VCdWNrZXRWZXJzaW9uaW5nQ29uZmlnKHhtbFJlc3VsdClcbiAgfVxuXG4gIGFzeW5jIHNldEJ1Y2tldFZlcnNpb25pbmcoYnVja2V0TmFtZTogc3RyaW5nLCB2ZXJzaW9uQ29uZmlnOiBCdWNrZXRWZXJzaW9uaW5nQ29uZmlndXJhdGlvbik6IFByb21pc2U8dm9pZD4ge1xuICAgIGlmICghaXNWYWxpZEJ1Y2tldE5hbWUoYnVja2V0TmFtZSkpIHtcbiAgICAgIHRocm93IG5ldyBlcnJvcnMuSW52YWxpZEJ1Y2tldE5hbWVFcnJvcignSW52YWxpZCBidWNrZXQgbmFtZTogJyArIGJ1Y2tldE5hbWUpXG4gICAgfVxuICAgIGlmICghT2JqZWN0LmtleXModmVyc2lvbkNvbmZpZykubGVuZ3RoKSB7XG4gICAgICB0aHJvdyBuZXcgZXJyb3JzLkludmFsaWRBcmd1bWVudEVycm9yKCd2ZXJzaW9uQ29uZmlnIHNob3VsZCBiZSBvZiB0eXBlIFwib2JqZWN0XCInKVxuICAgIH1cblxuICAgIGNvbnN0IG1ldGhvZCA9ICdQVVQnXG4gICAgY29uc3QgcXVlcnkgPSAndmVyc2lvbmluZydcbiAgICBjb25zdCBidWlsZGVyID0gbmV3IHhtbDJqcy5CdWlsZGVyKHtcbiAgICAgIHJvb3ROYW1lOiAnVmVyc2lvbmluZ0NvbmZpZ3VyYXRpb24nLFxuICAgICAgcmVuZGVyT3B0czogeyBwcmV0dHk6IGZhbHNlIH0sXG4gICAgICBoZWFkbGVzczogdHJ1ZSxcbiAgICB9KVxuICAgIGNvbnN0IHBheWxvYWQgPSBidWlsZGVyLmJ1aWxkT2JqZWN0KHZlcnNpb25Db25maWcpXG5cbiAgICBhd2FpdCB0aGlzLm1ha2VSZXF1ZXN0QXN5bmNPbWl0KHsgbWV0aG9kLCBidWNrZXROYW1lLCBxdWVyeSB9LCBwYXlsb2FkKVxuICB9XG5cbiAgcHJpdmF0ZSBhc3luYyBzZXRUYWdnaW5nKHRhZ2dpbmdQYXJhbXM6IFB1dFRhZ2dpbmdQYXJhbXMpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBjb25zdCB7IGJ1Y2tldE5hbWUsIG9iamVjdE5hbWUsIHRhZ3MsIHB1dE9wdHMgfSA9IHRhZ2dpbmdQYXJhbXNcbiAgICBjb25zdCBtZXRob2QgPSAnUFVUJ1xuICAgIGxldCBxdWVyeSA9ICd0YWdnaW5nJ1xuXG4gICAgaWYgKHB1dE9wdHMgJiYgcHV0T3B0cz8udmVyc2lvbklkKSB7XG4gICAgICBxdWVyeSA9IGAke3F1ZXJ5fSZ2ZXJzaW9uSWQ9JHtwdXRPcHRzLnZlcnNpb25JZH1gXG4gICAgfVxuICAgIGNvbnN0IHRhZ3NMaXN0ID0gW11cbiAgICBmb3IgKGNvbnN0IFtrZXksIHZhbHVlXSBvZiBPYmplY3QuZW50cmllcyh0YWdzKSkge1xuICAgICAgdGFnc0xpc3QucHVzaCh7IEtleToga2V5LCBWYWx1ZTogdmFsdWUgfSlcbiAgICB9XG4gICAgY29uc3QgdGFnZ2luZ0NvbmZpZyA9IHtcbiAgICAgIFRhZ2dpbmc6IHtcbiAgICAgICAgVGFnU2V0OiB7XG4gICAgICAgICAgVGFnOiB0YWdzTGlzdCxcbiAgICAgICAgfSxcbiAgICAgIH0sXG4gICAgfVxuICAgIGNvbnN0IGhlYWRlcnMgPSB7fSBhcyBSZXF1ZXN0SGVhZGVyc1xuICAgIGNvbnN0IGJ1aWxkZXIgPSBuZXcgeG1sMmpzLkJ1aWxkZXIoeyBoZWFkbGVzczogdHJ1ZSwgcmVuZGVyT3B0czogeyBwcmV0dHk6IGZhbHNlIH0gfSlcbiAgICBjb25zdCBwYXlsb2FkQnVmID0gQnVmZmVyLmZyb20oYnVpbGRlci5idWlsZE9iamVjdCh0YWdnaW5nQ29uZmlnKSlcbiAgICBjb25zdCByZXF1ZXN0T3B0aW9ucyA9IHtcbiAgICAgIG1ldGhvZCxcbiAgICAgIGJ1Y2tldE5hbWUsXG4gICAgICBxdWVyeSxcbiAgICAgIGhlYWRlcnMsXG5cbiAgICAgIC4uLihvYmplY3ROYW1lICYmIHsgb2JqZWN0TmFtZTogb2JqZWN0TmFtZSB9KSxcbiAgICB9XG5cbiAgICBoZWFkZXJzWydDb250ZW50LU1ENSddID0gdG9NZDUocGF5bG9hZEJ1ZilcblxuICAgIGF3YWl0IHRoaXMubWFrZVJlcXVlc3RBc3luY09taXQocmVxdWVzdE9wdGlvbnMsIHBheWxvYWRCdWYpXG4gIH1cblxuICBwcml2YXRlIGFzeW5jIHJlbW92ZVRhZ2dpbmcoeyBidWNrZXROYW1lLCBvYmplY3ROYW1lLCByZW1vdmVPcHRzIH06IFJlbW92ZVRhZ2dpbmdQYXJhbXMpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBjb25zdCBtZXRob2QgPSAnREVMRVRFJ1xuICAgIGxldCBxdWVyeSA9ICd0YWdnaW5nJ1xuXG4gICAgaWYgKHJlbW92ZU9wdHMgJiYgT2JqZWN0LmtleXMocmVtb3ZlT3B0cykubGVuZ3RoICYmIHJlbW92ZU9wdHMudmVyc2lvbklkKSB7XG4gICAgICBxdWVyeSA9IGAke3F1ZXJ5fSZ2ZXJzaW9uSWQ9JHtyZW1vdmVPcHRzLnZlcnNpb25JZH1gXG4gICAgfVxuICAgIGNvbnN0IHJlcXVlc3RPcHRpb25zID0geyBtZXRob2QsIGJ1Y2tldE5hbWUsIG9iamVjdE5hbWUsIHF1ZXJ5IH1cblxuICAgIGlmIChvYmplY3ROYW1lKSB7XG4gICAgICByZXF1ZXN0T3B0aW9uc1snb2JqZWN0TmFtZSddID0gb2JqZWN0TmFtZVxuICAgIH1cbiAgICBhd2FpdCB0aGlzLm1ha2VSZXF1ZXN0QXN5bmMocmVxdWVzdE9wdGlvbnMsICcnLCBbMjAwLCAyMDRdKVxuICB9XG5cbiAgYXN5bmMgc2V0QnVja2V0VGFnZ2luZyhidWNrZXROYW1lOiBzdHJpbmcsIHRhZ3M6IFRhZ3MpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBpZiAoIWlzVmFsaWRCdWNrZXROYW1lKGJ1Y2tldE5hbWUpKSB7XG4gICAgICB0aHJvdyBuZXcgZXJyb3JzLkludmFsaWRCdWNrZXROYW1lRXJyb3IoJ0ludmFsaWQgYnVja2V0IG5hbWU6ICcgKyBidWNrZXROYW1lKVxuICAgIH1cbiAgICBpZiAoIWlzUGxhaW5PYmplY3QodGFncykpIHtcbiAgICAgIHRocm93IG5ldyBlcnJvcnMuSW52YWxpZEFyZ3VtZW50RXJyb3IoJ3RhZ3Mgc2hvdWxkIGJlIG9mIHR5cGUgXCJvYmplY3RcIicpXG4gICAgfVxuICAgIGlmIChPYmplY3Qua2V5cyh0YWdzKS5sZW5ndGggPiAxMCkge1xuICAgICAgdGhyb3cgbmV3IGVycm9ycy5JbnZhbGlkQXJndW1lbnRFcnJvcignbWF4aW11bSB0YWdzIGFsbG93ZWQgaXMgMTBcIicpXG4gICAgfVxuXG4gICAgYXdhaXQgdGhpcy5zZXRUYWdnaW5nKHsgYnVja2V0TmFtZSwgdGFncyB9KVxuICB9XG5cbiAgYXN5bmMgcmVtb3ZlQnVja2V0VGFnZ2luZyhidWNrZXROYW1lOiBzdHJpbmcpIHtcbiAgICBpZiAoIWlzVmFsaWRCdWNrZXROYW1lKGJ1Y2tldE5hbWUpKSB7XG4gICAgICB0aHJvdyBuZXcgZXJyb3JzLkludmFsaWRCdWNrZXROYW1lRXJyb3IoJ0ludmFsaWQgYnVja2V0IG5hbWU6ICcgKyBidWNrZXROYW1lKVxuICAgIH1cbiAgICBhd2FpdCB0aGlzLnJlbW92ZVRhZ2dpbmcoeyBidWNrZXROYW1lIH0pXG4gIH1cblxuICBhc3luYyBzZXRPYmplY3RUYWdnaW5nKGJ1Y2tldE5hbWU6IHN0cmluZywgb2JqZWN0TmFtZTogc3RyaW5nLCB0YWdzOiBUYWdzLCBwdXRPcHRzPzogVGFnZ2luZ09wdHMpIHtcbiAgICBpZiAoIWlzVmFsaWRCdWNrZXROYW1lKGJ1Y2tldE5hbWUpKSB7XG4gICAgICB0aHJvdyBuZXcgZXJyb3JzLkludmFsaWRCdWNrZXROYW1lRXJyb3IoJ0ludmFsaWQgYnVja2V0IG5hbWU6ICcgKyBidWNrZXROYW1lKVxuICAgIH1cbiAgICBpZiAoIWlzVmFsaWRPYmplY3ROYW1lKG9iamVjdE5hbWUpKSB7XG4gICAgICB0aHJvdyBuZXcgZXJyb3JzLkludmFsaWRCdWNrZXROYW1lRXJyb3IoJ0ludmFsaWQgb2JqZWN0IG5hbWU6ICcgKyBvYmplY3ROYW1lKVxuICAgIH1cblxuICAgIGlmICghaXNQbGFpbk9iamVjdCh0YWdzKSkge1xuICAgICAgdGhyb3cgbmV3IGVycm9ycy5JbnZhbGlkQXJndW1lbnRFcnJvcigndGFncyBzaG91bGQgYmUgb2YgdHlwZSBcIm9iamVjdFwiJylcbiAgICB9XG4gICAgaWYgKE9iamVjdC5rZXlzKHRhZ3MpLmxlbmd0aCA+IDEwKSB7XG4gICAgICB0aHJvdyBuZXcgZXJyb3JzLkludmFsaWRBcmd1bWVudEVycm9yKCdNYXhpbXVtIHRhZ3MgYWxsb3dlZCBpcyAxMFwiJylcbiAgICB9XG5cbiAgICBhd2FpdCB0aGlzLnNldFRhZ2dpbmcoeyBidWNrZXROYW1lLCBvYmplY3ROYW1lLCB0YWdzLCBwdXRPcHRzIH0pXG4gIH1cblxuICBhc3luYyByZW1vdmVPYmplY3RUYWdnaW5nKGJ1Y2tldE5hbWU6IHN0cmluZywgb2JqZWN0TmFtZTogc3RyaW5nLCByZW1vdmVPcHRzOiBUYWdnaW5nT3B0cykge1xuICAgIGlmICghaXNWYWxpZEJ1Y2tldE5hbWUoYnVja2V0TmFtZSkpIHtcbiAgICAgIHRocm93IG5ldyBlcnJvcnMuSW52YWxpZEJ1Y2tldE5hbWVFcnJvcignSW52YWxpZCBidWNrZXQgbmFtZTogJyArIGJ1Y2tldE5hbWUpXG4gICAgfVxuICAgIGlmICghaXNWYWxpZE9iamVjdE5hbWUob2JqZWN0TmFtZSkpIHtcbiAgICAgIHRocm93IG5ldyBlcnJvcnMuSW52YWxpZEJ1Y2tldE5hbWVFcnJvcignSW52YWxpZCBvYmplY3QgbmFtZTogJyArIG9iamVjdE5hbWUpXG4gICAgfVxuICAgIGlmIChyZW1vdmVPcHRzICYmIE9iamVjdC5rZXlzKHJlbW92ZU9wdHMpLmxlbmd0aCAmJiAhaXNPYmplY3QocmVtb3ZlT3B0cykpIHtcbiAgICAgIHRocm93IG5ldyBlcnJvcnMuSW52YWxpZEFyZ3VtZW50RXJyb3IoJ3JlbW92ZU9wdHMgc2hvdWxkIGJlIG9mIHR5cGUgXCJvYmplY3RcIicpXG4gICAgfVxuXG4gICAgYXdhaXQgdGhpcy5yZW1vdmVUYWdnaW5nKHsgYnVja2V0TmFtZSwgb2JqZWN0TmFtZSwgcmVtb3ZlT3B0cyB9KVxuICB9XG5cbiAgYXN5bmMgc2VsZWN0T2JqZWN0Q29udGVudChcbiAgICBidWNrZXROYW1lOiBzdHJpbmcsXG4gICAgb2JqZWN0TmFtZTogc3RyaW5nLFxuICAgIHNlbGVjdE9wdHM6IFNlbGVjdE9wdGlvbnMsXG4gICk6IFByb21pc2U8U2VsZWN0UmVzdWx0cyB8IHVuZGVmaW5lZD4ge1xuICAgIGlmICghaXNWYWxpZEJ1Y2tldE5hbWUoYnVja2V0TmFtZSkpIHtcbiAgICAgIHRocm93IG5ldyBlcnJvcnMuSW52YWxpZEJ1Y2tldE5hbWVFcnJvcihgSW52YWxpZCBidWNrZXQgbmFtZTogJHtidWNrZXROYW1lfWApXG4gICAgfVxuICAgIGlmICghaXNWYWxpZE9iamVjdE5hbWUob2JqZWN0TmFtZSkpIHtcbiAgICAgIHRocm93IG5ldyBlcnJvcnMuSW52YWxpZE9iamVjdE5hbWVFcnJvcihgSW52YWxpZCBvYmplY3QgbmFtZTogJHtvYmplY3ROYW1lfWApXG4gICAgfVxuICAgIGlmICghXy5pc0VtcHR5KHNlbGVjdE9wdHMpKSB7XG4gICAgICBpZiAoIWlzU3RyaW5nKHNlbGVjdE9wdHMuZXhwcmVzc2lvbikpIHtcbiAgICAgICAgdGhyb3cgbmV3IFR5cGVFcnJvcignc3FsRXhwcmVzc2lvbiBzaG91bGQgYmUgb2YgdHlwZSBcInN0cmluZ1wiJylcbiAgICAgIH1cbiAgICAgIGlmICghXy5pc0VtcHR5KHNlbGVjdE9wdHMuaW5wdXRTZXJpYWxpemF0aW9uKSkge1xuICAgICAgICBpZiAoIWlzT2JqZWN0KHNlbGVjdE9wdHMuaW5wdXRTZXJpYWxpemF0aW9uKSkge1xuICAgICAgICAgIHRocm93IG5ldyBUeXBlRXJyb3IoJ2lucHV0U2VyaWFsaXphdGlvbiBzaG91bGQgYmUgb2YgdHlwZSBcIm9iamVjdFwiJylcbiAgICAgICAgfVxuICAgICAgfSBlbHNlIHtcbiAgICAgICAgdGhyb3cgbmV3IFR5cGVFcnJvcignaW5wdXRTZXJpYWxpemF0aW9uIGlzIHJlcXVpcmVkJylcbiAgICAgIH1cbiAgICAgIGlmICghXy5pc0VtcHR5KHNlbGVjdE9wdHMub3V0cHV0U2VyaWFsaXphdGlvbikpIHtcbiAgICAgICAgaWYgKCFpc09iamVjdChzZWxlY3RPcHRzLm91dHB1dFNlcmlhbGl6YXRpb24pKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IFR5cGVFcnJvcignb3V0cHV0U2VyaWFsaXphdGlvbiBzaG91bGQgYmUgb2YgdHlwZSBcIm9iamVjdFwiJylcbiAgICAgICAgfVxuICAgICAgfSBlbHNlIHtcbiAgICAgICAgdGhyb3cgbmV3IFR5cGVFcnJvcignb3V0cHV0U2VyaWFsaXphdGlvbiBpcyByZXF1aXJlZCcpXG4gICAgICB9XG4gICAgfSBlbHNlIHtcbiAgICAgIHRocm93IG5ldyBUeXBlRXJyb3IoJ3ZhbGlkIHNlbGVjdCBjb25maWd1cmF0aW9uIGlzIHJlcXVpcmVkJylcbiAgICB9XG5cbiAgICBjb25zdCBtZXRob2QgPSAnUE9TVCdcbiAgICBjb25zdCBxdWVyeSA9IGBzZWxlY3Qmc2VsZWN0LXR5cGU9MmBcblxuICAgIGNvbnN0IGNvbmZpZzogUmVjb3JkPHN0cmluZywgdW5rbm93bj5bXSA9IFtcbiAgICAgIHtcbiAgICAgICAgRXhwcmVzc2lvbjogc2VsZWN0T3B0cy5leHByZXNzaW9uLFxuICAgICAgfSxcbiAgICAgIHtcbiAgICAgICAgRXhwcmVzc2lvblR5cGU6IHNlbGVjdE9wdHMuZXhwcmVzc2lvblR5cGUgfHwgJ1NRTCcsXG4gICAgICB9LFxuICAgICAge1xuICAgICAgICBJbnB1dFNlcmlhbGl6YXRpb246IFtzZWxlY3RPcHRzLmlucHV0U2VyaWFsaXphdGlvbl0sXG4gICAgICB9LFxuICAgICAge1xuICAgICAgICBPdXRwdXRTZXJpYWxpemF0aW9uOiBbc2VsZWN0T3B0cy5vdXRwdXRTZXJpYWxpemF0aW9uXSxcbiAgICAgIH0sXG4gICAgXVxuXG4gICAgLy8gT3B0aW9uYWxcbiAgICBpZiAoc2VsZWN0T3B0cy5yZXF1ZXN0UHJvZ3Jlc3MpIHtcbiAgICAgIGNvbmZpZy5wdXNoKHsgUmVxdWVzdFByb2dyZXNzOiBzZWxlY3RPcHRzPy5yZXF1ZXN0UHJvZ3Jlc3MgfSlcbiAgICB9XG4gICAgLy8gT3B0aW9uYWxcbiAgICBpZiAoc2VsZWN0T3B0cy5zY2FuUmFuZ2UpIHtcbiAgICAgIGNvbmZpZy5wdXNoKHsgU2NhblJhbmdlOiBzZWxlY3RPcHRzLnNjYW5SYW5nZSB9KVxuICAgIH1cblxuICAgIGNvbnN0IGJ1aWxkZXIgPSBuZXcgeG1sMmpzLkJ1aWxkZXIoe1xuICAgICAgcm9vdE5hbWU6ICdTZWxlY3RPYmplY3RDb250ZW50UmVxdWVzdCcsXG4gICAgICByZW5kZXJPcHRzOiB7IHByZXR0eTogZmFsc2UgfSxcbiAgICAgIGhlYWRsZXNzOiB0cnVlLFxuICAgIH0pXG4gICAgY29uc3QgcGF5bG9hZCA9IGJ1aWxkZXIuYnVpbGRPYmplY3QoY29uZmlnKVxuXG4gICAgY29uc3QgcmVzID0gYXdhaXQgdGhpcy5tYWtlUmVxdWVzdEFzeW5jKHsgbWV0aG9kLCBidWNrZXROYW1lLCBvYmplY3ROYW1lLCBxdWVyeSB9LCBwYXlsb2FkKVxuICAgIGNvbnN0IGJvZHkgPSBhd2FpdCByZWFkQXNCdWZmZXIocmVzKVxuICAgIHJldHVybiBwYXJzZVNlbGVjdE9iamVjdENvbnRlbnRSZXNwb25zZShib2R5KVxuICB9XG5cbiAgcHJpdmF0ZSBhc3luYyBhcHBseUJ1Y2tldExpZmVjeWNsZShidWNrZXROYW1lOiBzdHJpbmcsIHBvbGljeUNvbmZpZzogTGlmZUN5Y2xlQ29uZmlnUGFyYW0pOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBjb25zdCBtZXRob2QgPSAnUFVUJ1xuICAgIGNvbnN0IHF1ZXJ5ID0gJ2xpZmVjeWNsZSdcblxuICAgIGNvbnN0IGhlYWRlcnM6IFJlcXVlc3RIZWFkZXJzID0ge31cbiAgICBjb25zdCBidWlsZGVyID0gbmV3IHhtbDJqcy5CdWlsZGVyKHtcbiAgICAgIHJvb3ROYW1lOiAnTGlmZWN5Y2xlQ29uZmlndXJhdGlvbicsXG4gICAgICBoZWFkbGVzczogdHJ1ZSxcbiAgICAgIHJlbmRlck9wdHM6IHsgcHJldHR5OiBmYWxzZSB9LFxuICAgIH0pXG4gICAgY29uc3QgcGF5bG9hZCA9IGJ1aWxkZXIuYnVpbGRPYmplY3QocG9saWN5Q29uZmlnKVxuICAgIGhlYWRlcnNbJ0NvbnRlbnQtTUQ1J10gPSB0b01kNShwYXlsb2FkKVxuXG4gICAgYXdhaXQgdGhpcy5tYWtlUmVxdWVzdEFzeW5jT21pdCh7IG1ldGhvZCwgYnVja2V0TmFtZSwgcXVlcnksIGhlYWRlcnMgfSwgcGF5bG9hZClcbiAgfVxuXG4gIGFzeW5jIHJlbW92ZUJ1Y2tldExpZmVjeWNsZShidWNrZXROYW1lOiBzdHJpbmcpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBpZiAoIWlzVmFsaWRCdWNrZXROYW1lKGJ1Y2tldE5hbWUpKSB7XG4gICAgICB0aHJvdyBuZXcgZXJyb3JzLkludmFsaWRCdWNrZXROYW1lRXJyb3IoJ0ludmFsaWQgYnVja2V0IG5hbWU6ICcgKyBidWNrZXROYW1lKVxuICAgIH1cbiAgICBjb25zdCBtZXRob2QgPSAnREVMRVRFJ1xuICAgIGNvbnN0IHF1ZXJ5ID0gJ2xpZmVjeWNsZSdcbiAgICBhd2FpdCB0aGlzLm1ha2VSZXF1ZXN0QXN5bmNPbWl0KHsgbWV0aG9kLCBidWNrZXROYW1lLCBxdWVyeSB9LCAnJywgWzIwNF0pXG4gIH1cblxuICBhc3luYyBzZXRCdWNrZXRMaWZlY3ljbGUoYnVja2V0TmFtZTogc3RyaW5nLCBsaWZlQ3ljbGVDb25maWc6IExpZmVDeWNsZUNvbmZpZ1BhcmFtKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgaWYgKCFpc1ZhbGlkQnVja2V0TmFtZShidWNrZXROYW1lKSkge1xuICAgICAgdGhyb3cgbmV3IGVycm9ycy5JbnZhbGlkQnVja2V0TmFtZUVycm9yKCdJbnZhbGlkIGJ1Y2tldCBuYW1lOiAnICsgYnVja2V0TmFtZSlcbiAgICB9XG4gICAgaWYgKF8uaXNFbXB0eShsaWZlQ3ljbGVDb25maWcpKSB7XG4gICAgICBhd2FpdCB0aGlzLnJlbW92ZUJ1Y2tldExpZmVjeWNsZShidWNrZXROYW1lKVxuICAgIH0gZWxzZSB7XG4gICAgICBhd2FpdCB0aGlzLmFwcGx5QnVja2V0TGlmZWN5Y2xlKGJ1Y2tldE5hbWUsIGxpZmVDeWNsZUNvbmZpZylcbiAgICB9XG4gIH1cblxuICBhc3luYyBnZXRCdWNrZXRMaWZlY3ljbGUoYnVja2V0TmFtZTogc3RyaW5nKTogUHJvbWlzZTxMaWZlY3ljbGVDb25maWcgfCBudWxsPiB7XG4gICAgaWYgKCFpc1ZhbGlkQnVja2V0TmFtZShidWNrZXROYW1lKSkge1xuICAgICAgdGhyb3cgbmV3IGVycm9ycy5JbnZhbGlkQnVja2V0TmFtZUVycm9yKCdJbnZhbGlkIGJ1Y2tldCBuYW1lOiAnICsgYnVja2V0TmFtZSlcbiAgICB9XG4gICAgY29uc3QgbWV0aG9kID0gJ0dFVCdcbiAgICBjb25zdCBxdWVyeSA9ICdsaWZlY3ljbGUnXG5cbiAgICBjb25zdCByZXMgPSBhd2FpdCB0aGlzLm1ha2VSZXF1ZXN0QXN5bmMoeyBtZXRob2QsIGJ1Y2tldE5hbWUsIHF1ZXJ5IH0pXG4gICAgY29uc3QgYm9keSA9IGF3YWl0IHJlYWRBc1N0cmluZyhyZXMpXG4gICAgcmV0dXJuIHhtbFBhcnNlcnMucGFyc2VMaWZlY3ljbGVDb25maWcoYm9keSlcbiAgfVxuXG4gIGFzeW5jIHNldEJ1Y2tldEVuY3J5cHRpb24oYnVja2V0TmFtZTogc3RyaW5nLCBlbmNyeXB0aW9uQ29uZmlnPzogRW5jcnlwdGlvbkNvbmZpZyk6IFByb21pc2U8dm9pZD4ge1xuICAgIGlmICghaXNWYWxpZEJ1Y2tldE5hbWUoYnVja2V0TmFtZSkpIHtcbiAgICAgIHRocm93IG5ldyBlcnJvcnMuSW52YWxpZEJ1Y2tldE5hbWVFcnJvcignSW52YWxpZCBidWNrZXQgbmFtZTogJyArIGJ1Y2tldE5hbWUpXG4gICAgfVxuICAgIGlmICghXy5pc0VtcHR5KGVuY3J5cHRpb25Db25maWcpICYmIGVuY3J5cHRpb25Db25maWcuUnVsZS5sZW5ndGggPiAxKSB7XG4gICAgICB0aHJvdyBuZXcgZXJyb3JzLkludmFsaWRBcmd1bWVudEVycm9yKCdJbnZhbGlkIFJ1bGUgbGVuZ3RoLiBPbmx5IG9uZSBydWxlIGlzIGFsbG93ZWQuOiAnICsgZW5jcnlwdGlvbkNvbmZpZy5SdWxlKVxuICAgIH1cblxuICAgIGxldCBlbmNyeXB0aW9uT2JqID0gZW5jcnlwdGlvbkNvbmZpZ1xuICAgIGlmIChfLmlzRW1wdHkoZW5jcnlwdGlvbkNvbmZpZykpIHtcbiAgICAgIGVuY3J5cHRpb25PYmogPSB7XG4gICAgICAgIC8vIERlZmF1bHQgTWluSU8gU2VydmVyIFN1cHBvcnRlZCBSdWxlXG4gICAgICAgIFJ1bGU6IFtcbiAgICAgICAgICB7XG4gICAgICAgICAgICBBcHBseVNlcnZlclNpZGVFbmNyeXB0aW9uQnlEZWZhdWx0OiB7XG4gICAgICAgICAgICAgIFNTRUFsZ29yaXRobTogJ0FFUzI1NicsXG4gICAgICAgICAgICB9LFxuICAgICAgICAgIH0sXG4gICAgICAgIF0sXG4gICAgICB9XG4gICAgfVxuXG4gICAgY29uc3QgbWV0aG9kID0gJ1BVVCdcbiAgICBjb25zdCBxdWVyeSA9ICdlbmNyeXB0aW9uJ1xuICAgIGNvbnN0IGJ1aWxkZXIgPSBuZXcgeG1sMmpzLkJ1aWxkZXIoe1xuICAgICAgcm9vdE5hbWU6ICdTZXJ2ZXJTaWRlRW5jcnlwdGlvbkNvbmZpZ3VyYXRpb24nLFxuICAgICAgcmVuZGVyT3B0czogeyBwcmV0dHk6IGZhbHNlIH0sXG4gICAgICBoZWFkbGVzczogdHJ1ZSxcbiAgICB9KVxuICAgIGNvbnN0IHBheWxvYWQgPSBidWlsZGVyLmJ1aWxkT2JqZWN0KGVuY3J5cHRpb25PYmopXG5cbiAgICBjb25zdCBoZWFkZXJzOiBSZXF1ZXN0SGVhZGVycyA9IHt9XG4gICAgaGVhZGVyc1snQ29udGVudC1NRDUnXSA9IHRvTWQ1KHBheWxvYWQpXG5cbiAgICBhd2FpdCB0aGlzLm1ha2VSZXF1ZXN0QXN5bmNPbWl0KHsgbWV0aG9kLCBidWNrZXROYW1lLCBxdWVyeSwgaGVhZGVycyB9LCBwYXlsb2FkKVxuICB9XG5cbiAgYXN5bmMgZ2V0QnVja2V0RW5jcnlwdGlvbihidWNrZXROYW1lOiBzdHJpbmcpIHtcbiAgICBpZiAoIWlzVmFsaWRCdWNrZXROYW1lKGJ1Y2tldE5hbWUpKSB7XG4gICAgICB0aHJvdyBuZXcgZXJyb3JzLkludmFsaWRCdWNrZXROYW1lRXJyb3IoJ0ludmFsaWQgYnVja2V0IG5hbWU6ICcgKyBidWNrZXROYW1lKVxuICAgIH1cbiAgICBjb25zdCBtZXRob2QgPSAnR0VUJ1xuICAgIGNvbnN0IHF1ZXJ5ID0gJ2VuY3J5cHRpb24nXG5cbiAgICBjb25zdCByZXMgPSBhd2FpdCB0aGlzLm1ha2VSZXF1ZXN0QXN5bmMoeyBtZXRob2QsIGJ1Y2tldE5hbWUsIHF1ZXJ5IH0pXG4gICAgY29uc3QgYm9keSA9IGF3YWl0IHJlYWRBc1N0cmluZyhyZXMpXG4gICAgcmV0dXJuIHhtbFBhcnNlcnMucGFyc2VCdWNrZXRFbmNyeXB0aW9uQ29uZmlnKGJvZHkpXG4gIH1cblxuICBhc3luYyByZW1vdmVCdWNrZXRFbmNyeXB0aW9uKGJ1Y2tldE5hbWU6IHN0cmluZykge1xuICAgIGlmICghaXNWYWxpZEJ1Y2tldE5hbWUoYnVja2V0TmFtZSkpIHtcbiAgICAgIHRocm93IG5ldyBlcnJvcnMuSW52YWxpZEJ1Y2tldE5hbWVFcnJvcignSW52YWxpZCBidWNrZXQgbmFtZTogJyArIGJ1Y2tldE5hbWUpXG4gICAgfVxuICAgIGNvbnN0IG1ldGhvZCA9ICdERUxFVEUnXG4gICAgY29uc3QgcXVlcnkgPSAnZW5jcnlwdGlvbidcblxuICAgIGF3YWl0IHRoaXMubWFrZVJlcXVlc3RBc3luY09taXQoeyBtZXRob2QsIGJ1Y2tldE5hbWUsIHF1ZXJ5IH0sICcnLCBbMjA0XSlcbiAgfVxuXG4gIGFzeW5jIGdldE9iamVjdFJldGVudGlvbihcbiAgICBidWNrZXROYW1lOiBzdHJpbmcsXG4gICAgb2JqZWN0TmFtZTogc3RyaW5nLFxuICAgIGdldE9wdHM/OiBHZXRPYmplY3RSZXRlbnRpb25PcHRzLFxuICApOiBQcm9taXNlPE9iamVjdFJldGVudGlvbkluZm8gfCBudWxsIHwgdW5kZWZpbmVkPiB7XG4gICAgaWYgKCFpc1ZhbGlkQnVja2V0TmFtZShidWNrZXROYW1lKSkge1xuICAgICAgdGhyb3cgbmV3IGVycm9ycy5JbnZhbGlkQnVja2V0TmFtZUVycm9yKCdJbnZhbGlkIGJ1Y2tldCBuYW1lOiAnICsgYnVja2V0TmFtZSlcbiAgICB9XG4gICAgaWYgKCFpc1ZhbGlkT2JqZWN0TmFtZShvYmplY3ROYW1lKSkge1xuICAgICAgdGhyb3cgbmV3IGVycm9ycy5JbnZhbGlkT2JqZWN0TmFtZUVycm9yKGBJbnZhbGlkIG9iamVjdCBuYW1lOiAke29iamVjdE5hbWV9YClcbiAgICB9XG4gICAgaWYgKGdldE9wdHMgJiYgIWlzT2JqZWN0KGdldE9wdHMpKSB7XG4gICAgICB0aHJvdyBuZXcgZXJyb3JzLkludmFsaWRBcmd1bWVudEVycm9yKCdnZXRPcHRzIHNob3VsZCBiZSBvZiB0eXBlIFwib2JqZWN0XCInKVxuICAgIH0gZWxzZSBpZiAoZ2V0T3B0cz8udmVyc2lvbklkICYmICFpc1N0cmluZyhnZXRPcHRzLnZlcnNpb25JZCkpIHtcbiAgICAgIHRocm93IG5ldyBlcnJvcnMuSW52YWxpZEFyZ3VtZW50RXJyb3IoJ3ZlcnNpb25JZCBzaG91bGQgYmUgb2YgdHlwZSBcInN0cmluZ1wiJylcbiAgICB9XG5cbiAgICBjb25zdCBtZXRob2QgPSAnR0VUJ1xuICAgIGxldCBxdWVyeSA9ICdyZXRlbnRpb24nXG4gICAgaWYgKGdldE9wdHM/LnZlcnNpb25JZCkge1xuICAgICAgcXVlcnkgKz0gYCZ2ZXJzaW9uSWQ9JHtnZXRPcHRzLnZlcnNpb25JZH1gXG4gICAgfVxuICAgIGNvbnN0IHJlcyA9IGF3YWl0IHRoaXMubWFrZVJlcXVlc3RBc3luYyh7IG1ldGhvZCwgYnVja2V0TmFtZSwgb2JqZWN0TmFtZSwgcXVlcnkgfSlcbiAgICBjb25zdCBib2R5ID0gYXdhaXQgcmVhZEFzU3RyaW5nKHJlcylcbiAgICByZXR1cm4geG1sUGFyc2Vycy5wYXJzZU9iamVjdFJldGVudGlvbkNvbmZpZyhib2R5KVxuICB9XG5cbiAgYXN5bmMgcmVtb3ZlT2JqZWN0cyhidWNrZXROYW1lOiBzdHJpbmcsIG9iamVjdHNMaXN0OiBSZW1vdmVPYmplY3RzUGFyYW0pOiBQcm9taXNlPFJlbW92ZU9iamVjdHNSZXNwb25zZVtdPiB7XG4gICAgaWYgKCFpc1ZhbGlkQnVja2V0TmFtZShidWNrZXROYW1lKSkge1xuICAgICAgdGhyb3cgbmV3IGVycm9ycy5JbnZhbGlkQnVja2V0TmFtZUVycm9yKCdJbnZhbGlkIGJ1Y2tldCBuYW1lOiAnICsgYnVja2V0TmFtZSlcbiAgICB9XG4gICAgaWYgKCFBcnJheS5pc0FycmF5KG9iamVjdHNMaXN0KSkge1xuICAgICAgdGhyb3cgbmV3IGVycm9ycy5JbnZhbGlkQXJndW1lbnRFcnJvcignb2JqZWN0c0xpc3Qgc2hvdWxkIGJlIGEgbGlzdCcpXG4gICAgfVxuXG4gICAgY29uc3QgcnVuRGVsZXRlT2JqZWN0cyA9IGFzeW5jIChiYXRjaDogUmVtb3ZlT2JqZWN0c1BhcmFtKTogUHJvbWlzZTxSZW1vdmVPYmplY3RzUmVzcG9uc2VbXT4gPT4ge1xuICAgICAgY29uc3QgZGVsT2JqZWN0czogUmVtb3ZlT2JqZWN0c1JlcXVlc3RFbnRyeVtdID0gYmF0Y2gubWFwKCh2YWx1ZSkgPT4ge1xuICAgICAgICByZXR1cm4gaXNPYmplY3QodmFsdWUpID8geyBLZXk6IHZhbHVlLm5hbWUsIFZlcnNpb25JZDogdmFsdWUudmVyc2lvbklkIH0gOiB7IEtleTogdmFsdWUgfVxuICAgICAgfSlcblxuICAgICAgY29uc3QgcmVtT2JqZWN0cyA9IHsgRGVsZXRlOiB7IFF1aWV0OiB0cnVlLCBPYmplY3Q6IGRlbE9iamVjdHMgfSB9XG4gICAgICBjb25zdCBwYXlsb2FkID0gQnVmZmVyLmZyb20obmV3IHhtbDJqcy5CdWlsZGVyKHsgaGVhZGxlc3M6IHRydWUgfSkuYnVpbGRPYmplY3QocmVtT2JqZWN0cykpXG4gICAgICBjb25zdCBoZWFkZXJzOiBSZXF1ZXN0SGVhZGVycyA9IHsgJ0NvbnRlbnQtTUQ1JzogdG9NZDUocGF5bG9hZCkgfVxuXG4gICAgICBjb25zdCByZXMgPSBhd2FpdCB0aGlzLm1ha2VSZXF1ZXN0QXN5bmMoeyBtZXRob2Q6ICdQT1NUJywgYnVja2V0TmFtZSwgcXVlcnk6ICdkZWxldGUnLCBoZWFkZXJzIH0sIHBheWxvYWQpXG4gICAgICBjb25zdCBib2R5ID0gYXdhaXQgcmVhZEFzU3RyaW5nKHJlcylcbiAgICAgIHJldHVybiB4bWxQYXJzZXJzLnJlbW92ZU9iamVjdHNQYXJzZXIoYm9keSlcbiAgICB9XG5cbiAgICBjb25zdCBtYXhFbnRyaWVzID0gMTAwMCAvLyBtYXggZW50cmllcyBhY2NlcHRlZCBpbiBzZXJ2ZXIgZm9yIERlbGV0ZU11bHRpcGxlT2JqZWN0cyBBUEkuXG4gICAgLy8gQ2xpZW50IHNpZGUgYmF0Y2hpbmdcbiAgICBjb25zdCBiYXRjaGVzID0gW11cbiAgICBmb3IgKGxldCBpID0gMDsgaSA8IG9iamVjdHNMaXN0Lmxlbmd0aDsgaSArPSBtYXhFbnRyaWVzKSB7XG4gICAgICBiYXRjaGVzLnB1c2gob2JqZWN0c0xpc3Quc2xpY2UoaSwgaSArIG1heEVudHJpZXMpKVxuICAgIH1cblxuICAgIGNvbnN0IGJhdGNoUmVzdWx0cyA9IGF3YWl0IFByb21pc2UuYWxsKGJhdGNoZXMubWFwKHJ1bkRlbGV0ZU9iamVjdHMpKVxuICAgIHJldHVybiBiYXRjaFJlc3VsdHMuZmxhdCgpXG4gIH1cblxuICBhc3luYyByZW1vdmVJbmNvbXBsZXRlVXBsb2FkKGJ1Y2tldE5hbWU6IHN0cmluZywgb2JqZWN0TmFtZTogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgaWYgKCFpc1ZhbGlkQnVja2V0TmFtZShidWNrZXROYW1lKSkge1xuICAgICAgdGhyb3cgbmV3IGVycm9ycy5Jc1ZhbGlkQnVja2V0TmFtZUVycm9yKCdJbnZhbGlkIGJ1Y2tldCBuYW1lOiAnICsgYnVja2V0TmFtZSlcbiAgICB9XG4gICAgaWYgKCFpc1ZhbGlkT2JqZWN0TmFtZShvYmplY3ROYW1lKSkge1xuICAgICAgdGhyb3cgbmV3IGVycm9ycy5JbnZhbGlkT2JqZWN0TmFtZUVycm9yKGBJbnZhbGlkIG9iamVjdCBuYW1lOiAke29iamVjdE5hbWV9YClcbiAgICB9XG4gICAgY29uc3QgcmVtb3ZlVXBsb2FkSWQgPSBhd2FpdCB0aGlzLmZpbmRVcGxvYWRJZChidWNrZXROYW1lLCBvYmplY3ROYW1lKVxuICAgIGNvbnN0IG1ldGhvZCA9ICdERUxFVEUnXG4gICAgY29uc3QgcXVlcnkgPSBgdXBsb2FkSWQ9JHtyZW1vdmVVcGxvYWRJZH1gXG4gICAgYXdhaXQgdGhpcy5tYWtlUmVxdWVzdEFzeW5jT21pdCh7IG1ldGhvZCwgYnVja2V0TmFtZSwgb2JqZWN0TmFtZSwgcXVlcnkgfSwgJycsIFsyMDRdKVxuICB9XG5cbiAgcHJpdmF0ZSBhc3luYyBjb3B5T2JqZWN0VjEoXG4gICAgdGFyZ2V0QnVja2V0TmFtZTogc3RyaW5nLFxuICAgIHRhcmdldE9iamVjdE5hbWU6IHN0cmluZyxcbiAgICBzb3VyY2VCdWNrZXROYW1lQW5kT2JqZWN0TmFtZTogc3RyaW5nLFxuICAgIGNvbmRpdGlvbnM/OiBudWxsIHwgQ29weUNvbmRpdGlvbnMsXG4gICkge1xuICAgIGlmICh0eXBlb2YgY29uZGl0aW9ucyA9PSAnZnVuY3Rpb24nKSB7XG4gICAgICBjb25kaXRpb25zID0gbnVsbFxuICAgIH1cblxuICAgIGlmICghaXNWYWxpZEJ1Y2tldE5hbWUodGFyZ2V0QnVja2V0TmFtZSkpIHtcbiAgICAgIHRocm93IG5ldyBlcnJvcnMuSW52YWxpZEJ1Y2tldE5hbWVFcnJvcignSW52YWxpZCBidWNrZXQgbmFtZTogJyArIHRhcmdldEJ1Y2tldE5hbWUpXG4gICAgfVxuICAgIGlmICghaXNWYWxpZE9iamVjdE5hbWUodGFyZ2V0T2JqZWN0TmFtZSkpIHtcbiAgICAgIHRocm93IG5ldyBlcnJvcnMuSW52YWxpZE9iamVjdE5hbWVFcnJvcihgSW52YWxpZCBvYmplY3QgbmFtZTogJHt0YXJnZXRPYmplY3ROYW1lfWApXG4gICAgfVxuICAgIGlmICghaXNTdHJpbmcoc291cmNlQnVja2V0TmFtZUFuZE9iamVjdE5hbWUpKSB7XG4gICAgICB0aHJvdyBuZXcgVHlwZUVycm9yKCdzb3VyY2VCdWNrZXROYW1lQW5kT2JqZWN0TmFtZSBzaG91bGQgYmUgb2YgdHlwZSBcInN0cmluZ1wiJylcbiAgICB9XG4gICAgaWYgKHNvdXJjZUJ1Y2tldE5hbWVBbmRPYmplY3ROYW1lID09PSAnJykge1xuICAgICAgdGhyb3cgbmV3IGVycm9ycy5JbnZhbGlkUHJlZml4RXJyb3IoYEVtcHR5IHNvdXJjZSBwcmVmaXhgKVxuICAgIH1cblxuICAgIGlmIChjb25kaXRpb25zICE9IG51bGwgJiYgIShjb25kaXRpb25zIGluc3RhbmNlb2YgQ29weUNvbmRpdGlvbnMpKSB7XG4gICAgICB0aHJvdyBuZXcgVHlwZUVycm9yKCdjb25kaXRpb25zIHNob3VsZCBiZSBvZiB0eXBlIFwiQ29weUNvbmRpdGlvbnNcIicpXG4gICAgfVxuXG4gICAgY29uc3QgaGVhZGVyczogUmVxdWVzdEhlYWRlcnMgPSB7fVxuICAgIGhlYWRlcnNbJ3gtYW16LWNvcHktc291cmNlJ10gPSB1cmlSZXNvdXJjZUVzY2FwZShzb3VyY2VCdWNrZXROYW1lQW5kT2JqZWN0TmFtZSlcblxuICAgIGlmIChjb25kaXRpb25zKSB7XG4gICAgICBpZiAoY29uZGl0aW9ucy5tb2RpZmllZCAhPT0gJycpIHtcbiAgICAgICAgaGVhZGVyc1sneC1hbXotY29weS1zb3VyY2UtaWYtbW9kaWZpZWQtc2luY2UnXSA9IGNvbmRpdGlvbnMubW9kaWZpZWRcbiAgICAgIH1cbiAgICAgIGlmIChjb25kaXRpb25zLnVubW9kaWZpZWQgIT09ICcnKSB7XG4gICAgICAgIGhlYWRlcnNbJ3gtYW16LWNvcHktc291cmNlLWlmLXVubW9kaWZpZWQtc2luY2UnXSA9IGNvbmRpdGlvbnMudW5tb2RpZmllZFxuICAgICAgfVxuICAgICAgaWYgKGNvbmRpdGlvbnMubWF0Y2hFVGFnICE9PSAnJykge1xuICAgICAgICBoZWFkZXJzWyd4LWFtei1jb3B5LXNvdXJjZS1pZi1tYXRjaCddID0gY29uZGl0aW9ucy5tYXRjaEVUYWdcbiAgICAgIH1cbiAgICAgIGlmIChjb25kaXRpb25zLm1hdGNoRVRhZ0V4Y2VwdCAhPT0gJycpIHtcbiAgICAgICAgaGVhZGVyc1sneC1hbXotY29weS1zb3VyY2UtaWYtbm9uZS1tYXRjaCddID0gY29uZGl0aW9ucy5tYXRjaEVUYWdFeGNlcHRcbiAgICAgIH1cbiAgICB9XG5cbiAgICBjb25zdCBtZXRob2QgPSAnUFVUJ1xuXG4gICAgY29uc3QgcmVzID0gYXdhaXQgdGhpcy5tYWtlUmVxdWVzdEFzeW5jKHtcbiAgICAgIG1ldGhvZCxcbiAgICAgIGJ1Y2tldE5hbWU6IHRhcmdldEJ1Y2tldE5hbWUsXG4gICAgICBvYmplY3ROYW1lOiB0YXJnZXRPYmplY3ROYW1lLFxuICAgICAgaGVhZGVycyxcbiAgICB9KVxuICAgIGNvbnN0IGJvZHkgPSBhd2FpdCByZWFkQXNTdHJpbmcocmVzKVxuICAgIHJldHVybiB4bWxQYXJzZXJzLnBhcnNlQ29weU9iamVjdChib2R5KVxuICB9XG5cbiAgcHJpdmF0ZSBhc3luYyBjb3B5T2JqZWN0VjIoXG4gICAgc291cmNlQ29uZmlnOiBDb3B5U291cmNlT3B0aW9ucyxcbiAgICBkZXN0Q29uZmlnOiBDb3B5RGVzdGluYXRpb25PcHRpb25zLFxuICApOiBQcm9taXNlPENvcHlPYmplY3RSZXN1bHRWMj4ge1xuICAgIGlmICghKHNvdXJjZUNvbmZpZyBpbnN0YW5jZW9mIENvcHlTb3VyY2VPcHRpb25zKSkge1xuICAgICAgdGhyb3cgbmV3IGVycm9ycy5JbnZhbGlkQXJndW1lbnRFcnJvcignc291cmNlQ29uZmlnIHNob3VsZCBvZiB0eXBlIENvcHlTb3VyY2VPcHRpb25zICcpXG4gICAgfVxuICAgIGlmICghKGRlc3RDb25maWcgaW5zdGFuY2VvZiBDb3B5RGVzdGluYXRpb25PcHRpb25zKSkge1xuICAgICAgdGhyb3cgbmV3IGVycm9ycy5JbnZhbGlkQXJndW1lbnRFcnJvcignZGVzdENvbmZpZyBzaG91bGQgb2YgdHlwZSBDb3B5RGVzdGluYXRpb25PcHRpb25zICcpXG4gICAgfVxuICAgIGlmICghZGVzdENvbmZpZy52YWxpZGF0ZSgpKSB7XG4gICAgICByZXR1cm4gUHJvbWlzZS5yZWplY3QoKVxuICAgIH1cbiAgICBpZiAoIWRlc3RDb25maWcudmFsaWRhdGUoKSkge1xuICAgICAgcmV0dXJuIFByb21pc2UucmVqZWN0KClcbiAgICB9XG5cbiAgICBjb25zdCBoZWFkZXJzID0gT2JqZWN0LmFzc2lnbih7fSwgc291cmNlQ29uZmlnLmdldEhlYWRlcnMoKSwgZGVzdENvbmZpZy5nZXRIZWFkZXJzKCkpXG5cbiAgICBjb25zdCBidWNrZXROYW1lID0gZGVzdENvbmZpZy5CdWNrZXRcbiAgICBjb25zdCBvYmplY3ROYW1lID0gZGVzdENvbmZpZy5PYmplY3RcblxuICAgIGNvbnN0IG1ldGhvZCA9ICdQVVQnXG5cbiAgICBjb25zdCByZXMgPSBhd2FpdCB0aGlzLm1ha2VSZXF1ZXN0QXN5bmMoeyBtZXRob2QsIGJ1Y2tldE5hbWUsIG9iamVjdE5hbWUsIGhlYWRlcnMgfSlcbiAgICBjb25zdCBib2R5ID0gYXdhaXQgcmVhZEFzU3RyaW5nKHJlcylcbiAgICBjb25zdCBjb3B5UmVzID0geG1sUGFyc2Vycy5wYXJzZUNvcHlPYmplY3QoYm9keSlcbiAgICBjb25zdCByZXNIZWFkZXJzOiBJbmNvbWluZ0h0dHBIZWFkZXJzID0gcmVzLmhlYWRlcnNcblxuICAgIGNvbnN0IHNpemVIZWFkZXJWYWx1ZSA9IHJlc0hlYWRlcnMgJiYgcmVzSGVhZGVyc1snY29udGVudC1sZW5ndGgnXVxuICAgIGNvbnN0IHNpemUgPSB0eXBlb2Ygc2l6ZUhlYWRlclZhbHVlID09PSAnbnVtYmVyJyA/IHNpemVIZWFkZXJWYWx1ZSA6IHVuZGVmaW5lZFxuXG4gICAgcmV0dXJuIHtcbiAgICAgIEJ1Y2tldDogZGVzdENvbmZpZy5CdWNrZXQsXG4gICAgICBLZXk6IGRlc3RDb25maWcuT2JqZWN0LFxuICAgICAgTGFzdE1vZGlmaWVkOiBjb3B5UmVzLmxhc3RNb2RpZmllZCxcbiAgICAgIE1ldGFEYXRhOiBleHRyYWN0TWV0YWRhdGEocmVzSGVhZGVycyBhcyBSZXNwb25zZUhlYWRlciksXG4gICAgICBWZXJzaW9uSWQ6IGdldFZlcnNpb25JZChyZXNIZWFkZXJzIGFzIFJlc3BvbnNlSGVhZGVyKSxcbiAgICAgIFNvdXJjZVZlcnNpb25JZDogZ2V0U291cmNlVmVyc2lvbklkKHJlc0hlYWRlcnMgYXMgUmVzcG9uc2VIZWFkZXIpLFxuICAgICAgRXRhZzogc2FuaXRpemVFVGFnKHJlc0hlYWRlcnMuZXRhZyksXG4gICAgICBTaXplOiBzaXplLFxuICAgIH1cbiAgfVxuXG4gIGFzeW5jIGNvcHlPYmplY3Qoc291cmNlOiBDb3B5U291cmNlT3B0aW9ucywgZGVzdDogQ29weURlc3RpbmF0aW9uT3B0aW9ucyk6IFByb21pc2U8Q29weU9iamVjdFJlc3VsdD5cbiAgYXN5bmMgY29weU9iamVjdChcbiAgICB0YXJnZXRCdWNrZXROYW1lOiBzdHJpbmcsXG4gICAgdGFyZ2V0T2JqZWN0TmFtZTogc3RyaW5nLFxuICAgIHNvdXJjZUJ1Y2tldE5hbWVBbmRPYmplY3ROYW1lOiBzdHJpbmcsXG4gICAgY29uZGl0aW9ucz86IENvcHlDb25kaXRpb25zLFxuICApOiBQcm9taXNlPENvcHlPYmplY3RSZXN1bHQ+XG4gIGFzeW5jIGNvcHlPYmplY3QoLi4uYWxsQXJnczogQ29weU9iamVjdFBhcmFtcyk6IFByb21pc2U8Q29weU9iamVjdFJlc3VsdD4ge1xuICAgIGlmICh0eXBlb2YgYWxsQXJnc1swXSA9PT0gJ3N0cmluZycpIHtcbiAgICAgIGNvbnN0IFt0YXJnZXRCdWNrZXROYW1lLCB0YXJnZXRPYmplY3ROYW1lLCBzb3VyY2VCdWNrZXROYW1lQW5kT2JqZWN0TmFtZSwgY29uZGl0aW9uc10gPSBhbGxBcmdzIGFzIFtcbiAgICAgICAgc3RyaW5nLFxuICAgICAgICBzdHJpbmcsXG4gICAgICAgIHN0cmluZyxcbiAgICAgICAgQ29weUNvbmRpdGlvbnM/LFxuICAgICAgXVxuICAgICAgcmV0dXJuIGF3YWl0IHRoaXMuY29weU9iamVjdFYxKHRhcmdldEJ1Y2tldE5hbWUsIHRhcmdldE9iamVjdE5hbWUsIHNvdXJjZUJ1Y2tldE5hbWVBbmRPYmplY3ROYW1lLCBjb25kaXRpb25zKVxuICAgIH1cbiAgICBjb25zdCBbc291cmNlLCBkZXN0XSA9IGFsbEFyZ3MgYXMgW0NvcHlTb3VyY2VPcHRpb25zLCBDb3B5RGVzdGluYXRpb25PcHRpb25zXVxuICAgIHJldHVybiBhd2FpdCB0aGlzLmNvcHlPYmplY3RWMihzb3VyY2UsIGRlc3QpXG4gIH1cblxuICBhc3luYyB1cGxvYWRQYXJ0KFxuICAgIHBhcnRDb25maWc6IHtcbiAgICAgIGJ1Y2tldE5hbWU6IHN0cmluZ1xuICAgICAgb2JqZWN0TmFtZTogc3RyaW5nXG4gICAgICB1cGxvYWRJRDogc3RyaW5nXG4gICAgICBwYXJ0TnVtYmVyOiBudW1iZXJcbiAgICAgIGhlYWRlcnM6IFJlcXVlc3RIZWFkZXJzXG4gICAgfSxcbiAgICBwYXlsb2FkPzogQmluYXJ5LFxuICApIHtcbiAgICBjb25zdCB7IGJ1Y2tldE5hbWUsIG9iamVjdE5hbWUsIHVwbG9hZElELCBwYXJ0TnVtYmVyLCBoZWFkZXJzIH0gPSBwYXJ0Q29uZmlnXG5cbiAgICBjb25zdCBtZXRob2QgPSAnUFVUJ1xuICAgIGNvbnN0IHF1ZXJ5ID0gYHVwbG9hZElkPSR7dXBsb2FkSUR9JnBhcnROdW1iZXI9JHtwYXJ0TnVtYmVyfWBcbiAgICBjb25zdCByZXF1ZXN0T3B0aW9ucyA9IHsgbWV0aG9kLCBidWNrZXROYW1lLCBvYmplY3ROYW1lOiBvYmplY3ROYW1lLCBxdWVyeSwgaGVhZGVycyB9XG4gICAgY29uc3QgcmVzID0gYXdhaXQgdGhpcy5tYWtlUmVxdWVzdEFzeW5jKHJlcXVlc3RPcHRpb25zLCBwYXlsb2FkKVxuICAgIGNvbnN0IGJvZHkgPSBhd2FpdCByZWFkQXNTdHJpbmcocmVzKVxuICAgIGNvbnN0IHBhcnRSZXMgPSB1cGxvYWRQYXJ0UGFyc2VyKGJvZHkpXG4gICAgcmV0dXJuIHtcbiAgICAgIGV0YWc6IHNhbml0aXplRVRhZyhwYXJ0UmVzLkVUYWcpLFxuICAgICAga2V5OiBvYmplY3ROYW1lLFxuICAgICAgcGFydDogcGFydE51bWJlcixcbiAgICB9XG4gIH1cblxuICBhc3luYyBjb21wb3NlT2JqZWN0KFxuICAgIGRlc3RPYmpDb25maWc6IENvcHlEZXN0aW5hdGlvbk9wdGlvbnMsXG4gICAgc291cmNlT2JqTGlzdDogQ29weVNvdXJjZU9wdGlvbnNbXSxcbiAgKTogUHJvbWlzZTxib29sZWFuIHwgeyBldGFnOiBzdHJpbmc7IHZlcnNpb25JZDogc3RyaW5nIHwgbnVsbCB9IHwgUHJvbWlzZTx2b2lkPiB8IENvcHlPYmplY3RSZXN1bHQ+IHtcbiAgICBjb25zdCBzb3VyY2VGaWxlc0xlbmd0aCA9IHNvdXJjZU9iakxpc3QubGVuZ3RoXG5cbiAgICBpZiAoIUFycmF5LmlzQXJyYXkoc291cmNlT2JqTGlzdCkpIHtcbiAgICAgIHRocm93IG5ldyBlcnJvcnMuSW52YWxpZEFyZ3VtZW50RXJyb3IoJ3NvdXJjZUNvbmZpZyBzaG91bGQgYW4gYXJyYXkgb2YgQ29weVNvdXJjZU9wdGlvbnMgJylcbiAgICB9XG4gICAgaWYgKCEoZGVzdE9iakNvbmZpZyBpbnN0YW5jZW9mIENvcHlEZXN0aW5hdGlvbk9wdGlvbnMpKSB7XG4gICAgICB0aHJvdyBuZXcgZXJyb3JzLkludmFsaWRBcmd1bWVudEVycm9yKCdkZXN0Q29uZmlnIHNob3VsZCBvZiB0eXBlIENvcHlEZXN0aW5hdGlvbk9wdGlvbnMgJylcbiAgICB9XG5cbiAgICBpZiAoc291cmNlRmlsZXNMZW5ndGggPCAxIHx8IHNvdXJjZUZpbGVzTGVuZ3RoID4gUEFSVF9DT05TVFJBSU5UUy5NQVhfUEFSVFNfQ09VTlQpIHtcbiAgICAgIHRocm93IG5ldyBlcnJvcnMuSW52YWxpZEFyZ3VtZW50RXJyb3IoXG4gICAgICAgIGBcIlRoZXJlIG11c3QgYmUgYXMgbGVhc3Qgb25lIGFuZCB1cCB0byAke1BBUlRfQ09OU1RSQUlOVFMuTUFYX1BBUlRTX0NPVU5UfSBzb3VyY2Ugb2JqZWN0cy5gLFxuICAgICAgKVxuICAgIH1cblxuICAgIGZvciAobGV0IGkgPSAwOyBpIDwgc291cmNlRmlsZXNMZW5ndGg7IGkrKykge1xuICAgICAgY29uc3Qgc09iaiA9IHNvdXJjZU9iakxpc3RbaV0gYXMgQ29weVNvdXJjZU9wdGlvbnNcbiAgICAgIGlmICghc09iai52YWxpZGF0ZSgpKSB7XG4gICAgICAgIHJldHVybiBmYWxzZVxuICAgICAgfVxuICAgIH1cblxuICAgIGlmICghKGRlc3RPYmpDb25maWcgYXMgQ29weURlc3RpbmF0aW9uT3B0aW9ucykudmFsaWRhdGUoKSkge1xuICAgICAgcmV0dXJuIGZhbHNlXG4gICAgfVxuXG4gICAgY29uc3QgZ2V0U3RhdE9wdGlvbnMgPSAoc3JjQ29uZmlnOiBDb3B5U291cmNlT3B0aW9ucykgPT4ge1xuICAgICAgbGV0IHN0YXRPcHRzID0ge31cbiAgICAgIGlmICghXy5pc0VtcHR5KHNyY0NvbmZpZy5WZXJzaW9uSUQpKSB7XG4gICAgICAgIHN0YXRPcHRzID0ge1xuICAgICAgICAgIHZlcnNpb25JZDogc3JjQ29uZmlnLlZlcnNpb25JRCxcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgcmV0dXJuIHN0YXRPcHRzXG4gICAgfVxuICAgIGNvbnN0IHNyY09iamVjdFNpemVzOiBudW1iZXJbXSA9IFtdXG4gICAgbGV0IHRvdGFsU2l6ZSA9IDBcbiAgICBsZXQgdG90YWxQYXJ0cyA9IDBcblxuICAgIGNvbnN0IHNvdXJjZU9ialN0YXRzID0gc291cmNlT2JqTGlzdC5tYXAoKHNyY0l0ZW0pID0+XG4gICAgICB0aGlzLnN0YXRPYmplY3Qoc3JjSXRlbS5CdWNrZXQsIHNyY0l0ZW0uT2JqZWN0LCBnZXRTdGF0T3B0aW9ucyhzcmNJdGVtKSksXG4gICAgKVxuXG4gICAgY29uc3Qgc3JjT2JqZWN0SW5mb3MgPSBhd2FpdCBQcm9taXNlLmFsbChzb3VyY2VPYmpTdGF0cylcblxuICAgIGNvbnN0IHZhbGlkYXRlZFN0YXRzID0gc3JjT2JqZWN0SW5mb3MubWFwKChyZXNJdGVtU3RhdCwgaW5kZXgpID0+IHtcbiAgICAgIGNvbnN0IHNyY0NvbmZpZzogQ29weVNvdXJjZU9wdGlvbnMgfCB1bmRlZmluZWQgPSBzb3VyY2VPYmpMaXN0W2luZGV4XVxuXG4gICAgICBsZXQgc3JjQ29weVNpemUgPSByZXNJdGVtU3RhdC5zaXplXG4gICAgICAvLyBDaGVjayBpZiBhIHNlZ21lbnQgaXMgc3BlY2lmaWVkLCBhbmQgaWYgc28sIGlzIHRoZVxuICAgICAgLy8gc2VnbWVudCB3aXRoaW4gb2JqZWN0IGJvdW5kcz9cbiAgICAgIGlmIChzcmNDb25maWcgJiYgc3JjQ29uZmlnLk1hdGNoUmFuZ2UpIHtcbiAgICAgICAgLy8gU2luY2UgcmFuZ2UgaXMgc3BlY2lmaWVkLFxuICAgICAgICAvLyAgICAwIDw9IHNyYy5zcmNTdGFydCA8PSBzcmMuc3JjRW5kXG4gICAgICAgIC8vIHNvIG9ubHkgaW52YWxpZCBjYXNlIHRvIGNoZWNrIGlzOlxuICAgICAgICBjb25zdCBzcmNTdGFydCA9IHNyY0NvbmZpZy5TdGFydFxuICAgICAgICBjb25zdCBzcmNFbmQgPSBzcmNDb25maWcuRW5kXG4gICAgICAgIGlmIChzcmNFbmQgPj0gc3JjQ29weVNpemUgfHwgc3JjU3RhcnQgPCAwKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IGVycm9ycy5JbnZhbGlkQXJndW1lbnRFcnJvcihcbiAgICAgICAgICAgIGBDb3B5U3JjT3B0aW9ucyAke2luZGV4fSBoYXMgaW52YWxpZCBzZWdtZW50LXRvLWNvcHkgWyR7c3JjU3RhcnR9LCAke3NyY0VuZH1dIChzaXplIGlzICR7c3JjQ29weVNpemV9KWAsXG4gICAgICAgICAgKVxuICAgICAgICB9XG4gICAgICAgIHNyY0NvcHlTaXplID0gc3JjRW5kIC0gc3JjU3RhcnQgKyAxXG4gICAgICB9XG5cbiAgICAgIC8vIE9ubHkgdGhlIGxhc3Qgc291cmNlIG1heSBiZSBsZXNzIHRoYW4gYGFic01pblBhcnRTaXplYFxuICAgICAgaWYgKHNyY0NvcHlTaXplIDwgUEFSVF9DT05TVFJBSU5UUy5BQlNfTUlOX1BBUlRfU0laRSAmJiBpbmRleCA8IHNvdXJjZUZpbGVzTGVuZ3RoIC0gMSkge1xuICAgICAgICB0aHJvdyBuZXcgZXJyb3JzLkludmFsaWRBcmd1bWVudEVycm9yKFxuICAgICAgICAgIGBDb3B5U3JjT3B0aW9ucyAke2luZGV4fSBpcyB0b28gc21hbGwgKCR7c3JjQ29weVNpemV9KSBhbmQgaXQgaXMgbm90IHRoZSBsYXN0IHBhcnQuYCxcbiAgICAgICAgKVxuICAgICAgfVxuXG4gICAgICAvLyBJcyBkYXRhIHRvIGNvcHkgdG9vIGxhcmdlP1xuICAgICAgdG90YWxTaXplICs9IHNyY0NvcHlTaXplXG4gICAgICBpZiAodG90YWxTaXplID4gUEFSVF9DT05TVFJBSU5UUy5NQVhfTVVMVElQQVJUX1BVVF9PQkpFQ1RfU0laRSkge1xuICAgICAgICB0aHJvdyBuZXcgZXJyb3JzLkludmFsaWRBcmd1bWVudEVycm9yKGBDYW5ub3QgY29tcG9zZSBhbiBvYmplY3Qgb2Ygc2l6ZSAke3RvdGFsU2l6ZX0gKD4gNVRpQilgKVxuICAgICAgfVxuXG4gICAgICAvLyByZWNvcmQgc291cmNlIHNpemVcbiAgICAgIHNyY09iamVjdFNpemVzW2luZGV4XSA9IHNyY0NvcHlTaXplXG5cbiAgICAgIC8vIGNhbGN1bGF0ZSBwYXJ0cyBuZWVkZWQgZm9yIGN1cnJlbnQgc291cmNlXG4gICAgICB0b3RhbFBhcnRzICs9IHBhcnRzUmVxdWlyZWQoc3JjQ29weVNpemUpXG4gICAgICAvLyBEbyB3ZSBuZWVkIG1vcmUgcGFydHMgdGhhbiB3ZSBhcmUgYWxsb3dlZD9cbiAgICAgIGlmICh0b3RhbFBhcnRzID4gUEFSVF9DT05TVFJBSU5UUy5NQVhfUEFSVFNfQ09VTlQpIHtcbiAgICAgICAgdGhyb3cgbmV3IGVycm9ycy5JbnZhbGlkQXJndW1lbnRFcnJvcihcbiAgICAgICAgICBgWW91ciBwcm9wb3NlZCBjb21wb3NlIG9iamVjdCByZXF1aXJlcyBtb3JlIHRoYW4gJHtQQVJUX0NPTlNUUkFJTlRTLk1BWF9QQVJUU19DT1VOVH0gcGFydHNgLFxuICAgICAgICApXG4gICAgICB9XG5cbiAgICAgIHJldHVybiByZXNJdGVtU3RhdFxuICAgIH0pXG5cbiAgICBpZiAoKHRvdGFsUGFydHMgPT09IDEgJiYgdG90YWxTaXplIDw9IFBBUlRfQ09OU1RSQUlOVFMuTUFYX1BBUlRfU0laRSkgfHwgdG90YWxTaXplID09PSAwKSB7XG4gICAgICByZXR1cm4gYXdhaXQgdGhpcy5jb3B5T2JqZWN0KHNvdXJjZU9iakxpc3RbMF0gYXMgQ29weVNvdXJjZU9wdGlvbnMsIGRlc3RPYmpDb25maWcpIC8vIHVzZSBjb3B5T2JqZWN0VjJcbiAgICB9XG5cbiAgICAvLyBwcmVzZXJ2ZSBldGFnIHRvIGF2b2lkIG1vZGlmaWNhdGlvbiBvZiBvYmplY3Qgd2hpbGUgY29weWluZy5cbiAgICBmb3IgKGxldCBpID0gMDsgaSA8IHNvdXJjZUZpbGVzTGVuZ3RoOyBpKyspIHtcbiAgICAgIDsoc291cmNlT2JqTGlzdFtpXSBhcyBDb3B5U291cmNlT3B0aW9ucykuTWF0Y2hFVGFnID0gKHZhbGlkYXRlZFN0YXRzW2ldIGFzIEJ1Y2tldEl0ZW1TdGF0KS5ldGFnXG4gICAgfVxuXG4gICAgY29uc3Qgc3BsaXRQYXJ0U2l6ZUxpc3QgPSB2YWxpZGF0ZWRTdGF0cy5tYXAoKHJlc0l0ZW1TdGF0LCBpZHgpID0+IHtcbiAgICAgIHJldHVybiBjYWxjdWxhdGVFdmVuU3BsaXRzKHNyY09iamVjdFNpemVzW2lkeF0gYXMgbnVtYmVyLCBzb3VyY2VPYmpMaXN0W2lkeF0gYXMgQ29weVNvdXJjZU9wdGlvbnMpXG4gICAgfSlcblxuICAgIGNvbnN0IGdldFVwbG9hZFBhcnRDb25maWdMaXN0ID0gKHVwbG9hZElkOiBzdHJpbmcpID0+IHtcbiAgICAgIGNvbnN0IHVwbG9hZFBhcnRDb25maWdMaXN0OiBVcGxvYWRQYXJ0Q29uZmlnW10gPSBbXVxuXG4gICAgICBzcGxpdFBhcnRTaXplTGlzdC5mb3JFYWNoKChzcGxpdFNpemUsIHNwbGl0SW5kZXg6IG51bWJlcikgPT4ge1xuICAgICAgICBpZiAoc3BsaXRTaXplKSB7XG4gICAgICAgICAgY29uc3QgeyBzdGFydEluZGV4OiBzdGFydElkeCwgZW5kSW5kZXg6IGVuZElkeCwgb2JqSW5mbzogb2JqQ29uZmlnIH0gPSBzcGxpdFNpemVcblxuICAgICAgICAgIGNvbnN0IHBhcnRJbmRleCA9IHNwbGl0SW5kZXggKyAxIC8vIHBhcnQgaW5kZXggc3RhcnRzIGZyb20gMS5cbiAgICAgICAgICBjb25zdCB0b3RhbFVwbG9hZHMgPSBBcnJheS5mcm9tKHN0YXJ0SWR4KVxuXG4gICAgICAgICAgY29uc3QgaGVhZGVycyA9IChzb3VyY2VPYmpMaXN0W3NwbGl0SW5kZXhdIGFzIENvcHlTb3VyY2VPcHRpb25zKS5nZXRIZWFkZXJzKClcblxuICAgICAgICAgIHRvdGFsVXBsb2Fkcy5mb3JFYWNoKChzcGxpdFN0YXJ0LCB1cGxkQ3RySWR4KSA9PiB7XG4gICAgICAgICAgICBjb25zdCBzcGxpdEVuZCA9IGVuZElkeFt1cGxkQ3RySWR4XVxuXG4gICAgICAgICAgICBjb25zdCBzb3VyY2VPYmogPSBgJHtvYmpDb25maWcuQnVja2V0fS8ke29iakNvbmZpZy5PYmplY3R9YFxuICAgICAgICAgICAgaGVhZGVyc1sneC1hbXotY29weS1zb3VyY2UnXSA9IGAke3NvdXJjZU9ian1gXG4gICAgICAgICAgICBoZWFkZXJzWyd4LWFtei1jb3B5LXNvdXJjZS1yYW5nZSddID0gYGJ5dGVzPSR7c3BsaXRTdGFydH0tJHtzcGxpdEVuZH1gXG5cbiAgICAgICAgICAgIGNvbnN0IHVwbG9hZFBhcnRDb25maWcgPSB7XG4gICAgICAgICAgICAgIGJ1Y2tldE5hbWU6IGRlc3RPYmpDb25maWcuQnVja2V0LFxuICAgICAgICAgICAgICBvYmplY3ROYW1lOiBkZXN0T2JqQ29uZmlnLk9iamVjdCxcbiAgICAgICAgICAgICAgdXBsb2FkSUQ6IHVwbG9hZElkLFxuICAgICAgICAgICAgICBwYXJ0TnVtYmVyOiBwYXJ0SW5kZXgsXG4gICAgICAgICAgICAgIGhlYWRlcnM6IGhlYWRlcnMsXG4gICAgICAgICAgICAgIHNvdXJjZU9iajogc291cmNlT2JqLFxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICB1cGxvYWRQYXJ0Q29uZmlnTGlzdC5wdXNoKHVwbG9hZFBhcnRDb25maWcpXG4gICAgICAgICAgfSlcbiAgICAgICAgfVxuICAgICAgfSlcblxuICAgICAgcmV0dXJuIHVwbG9hZFBhcnRDb25maWdMaXN0XG4gICAgfVxuXG4gICAgY29uc3QgdXBsb2FkQWxsUGFydHMgPSBhc3luYyAodXBsb2FkTGlzdDogVXBsb2FkUGFydENvbmZpZ1tdKSA9PiB7XG4gICAgICBjb25zdCBwYXJ0VXBsb2FkcyA9IHVwbG9hZExpc3QubWFwKGFzeW5jIChpdGVtKSA9PiB7XG4gICAgICAgIHJldHVybiB0aGlzLnVwbG9hZFBhcnQoaXRlbSlcbiAgICAgIH0pXG4gICAgICAvLyBQcm9jZXNzIHJlc3VsdHMgaGVyZSBpZiBuZWVkZWRcbiAgICAgIHJldHVybiBhd2FpdCBQcm9taXNlLmFsbChwYXJ0VXBsb2FkcylcbiAgICB9XG5cbiAgICBjb25zdCBwZXJmb3JtVXBsb2FkUGFydHMgPSBhc3luYyAodXBsb2FkSWQ6IHN0cmluZykgPT4ge1xuICAgICAgY29uc3QgdXBsb2FkTGlzdCA9IGdldFVwbG9hZFBhcnRDb25maWdMaXN0KHVwbG9hZElkKVxuICAgICAgY29uc3QgcGFydHNSZXMgPSBhd2FpdCB1cGxvYWRBbGxQYXJ0cyh1cGxvYWRMaXN0KVxuICAgICAgcmV0dXJuIHBhcnRzUmVzLm1hcCgocGFydENvcHkpID0+ICh7IGV0YWc6IHBhcnRDb3B5LmV0YWcsIHBhcnQ6IHBhcnRDb3B5LnBhcnQgfSkpXG4gICAgfVxuXG4gICAgY29uc3QgbmV3VXBsb2FkSGVhZGVycyA9IGRlc3RPYmpDb25maWcuZ2V0SGVhZGVycygpXG5cbiAgICBjb25zdCB1cGxvYWRJZCA9IGF3YWl0IHRoaXMuaW5pdGlhdGVOZXdNdWx0aXBhcnRVcGxvYWQoZGVzdE9iakNvbmZpZy5CdWNrZXQsIGRlc3RPYmpDb25maWcuT2JqZWN0LCBuZXdVcGxvYWRIZWFkZXJzKVxuICAgIHRyeSB7XG4gICAgICBjb25zdCBwYXJ0c0RvbmUgPSBhd2FpdCBwZXJmb3JtVXBsb2FkUGFydHModXBsb2FkSWQpXG4gICAgICByZXR1cm4gYXdhaXQgdGhpcy5jb21wbGV0ZU11bHRpcGFydFVwbG9hZChkZXN0T2JqQ29uZmlnLkJ1Y2tldCwgZGVzdE9iakNvbmZpZy5PYmplY3QsIHVwbG9hZElkLCBwYXJ0c0RvbmUpXG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICByZXR1cm4gYXdhaXQgdGhpcy5hYm9ydE11bHRpcGFydFVwbG9hZChkZXN0T2JqQ29uZmlnLkJ1Y2tldCwgZGVzdE9iakNvbmZpZy5PYmplY3QsIHVwbG9hZElkKVxuICAgIH1cbiAgfVxuXG4gIGFzeW5jIHByZXNpZ25lZFVybChcbiAgICBtZXRob2Q6IHN0cmluZyxcbiAgICBidWNrZXROYW1lOiBzdHJpbmcsXG4gICAgb2JqZWN0TmFtZTogc3RyaW5nLFxuICAgIGV4cGlyZXM/OiBudW1iZXIgfCBQcmVTaWduUmVxdWVzdFBhcmFtcyB8IHVuZGVmaW5lZCxcbiAgICByZXFQYXJhbXM/OiBQcmVTaWduUmVxdWVzdFBhcmFtcyB8IERhdGUsXG4gICAgcmVxdWVzdERhdGU/OiBEYXRlLFxuICApOiBQcm9taXNlPHN0cmluZz4ge1xuICAgIGlmICh0aGlzLmFub255bW91cykge1xuICAgICAgdGhyb3cgbmV3IGVycm9ycy5Bbm9ueW1vdXNSZXF1ZXN0RXJyb3IoYFByZXNpZ25lZCAke21ldGhvZH0gdXJsIGNhbm5vdCBiZSBnZW5lcmF0ZWQgZm9yIGFub255bW91cyByZXF1ZXN0c2ApXG4gICAgfVxuXG4gICAgaWYgKCFleHBpcmVzKSB7XG4gICAgICBleHBpcmVzID0gUFJFU0lHTl9FWFBJUllfREFZU19NQVhcbiAgICB9XG4gICAgaWYgKCFyZXFQYXJhbXMpIHtcbiAgICAgIHJlcVBhcmFtcyA9IHt9XG4gICAgfVxuICAgIGlmICghcmVxdWVzdERhdGUpIHtcbiAgICAgIHJlcXVlc3REYXRlID0gbmV3IERhdGUoKVxuICAgIH1cblxuICAgIC8vIFR5cGUgYXNzZXJ0aW9uc1xuICAgIGlmIChleHBpcmVzICYmIHR5cGVvZiBleHBpcmVzICE9PSAnbnVtYmVyJykge1xuICAgICAgdGhyb3cgbmV3IFR5cGVFcnJvcignZXhwaXJlcyBzaG91bGQgYmUgb2YgdHlwZSBcIm51bWJlclwiJylcbiAgICB9XG4gICAgaWYgKHJlcVBhcmFtcyAmJiB0eXBlb2YgcmVxUGFyYW1zICE9PSAnb2JqZWN0Jykge1xuICAgICAgdGhyb3cgbmV3IFR5cGVFcnJvcigncmVxUGFyYW1zIHNob3VsZCBiZSBvZiB0eXBlIFwib2JqZWN0XCInKVxuICAgIH1cbiAgICBpZiAoKHJlcXVlc3REYXRlICYmICEocmVxdWVzdERhdGUgaW5zdGFuY2VvZiBEYXRlKSkgfHwgKHJlcXVlc3REYXRlICYmIGlzTmFOKHJlcXVlc3REYXRlPy5nZXRUaW1lKCkpKSkge1xuICAgICAgdGhyb3cgbmV3IFR5cGVFcnJvcigncmVxdWVzdERhdGUgc2hvdWxkIGJlIG9mIHR5cGUgXCJEYXRlXCIgYW5kIHZhbGlkJylcbiAgICB9XG5cbiAgICBjb25zdCBxdWVyeSA9IHJlcVBhcmFtcyA/IHFzLnN0cmluZ2lmeShyZXFQYXJhbXMpIDogdW5kZWZpbmVkXG5cbiAgICB0cnkge1xuICAgICAgY29uc3QgcmVnaW9uID0gYXdhaXQgdGhpcy5nZXRCdWNrZXRSZWdpb25Bc3luYyhidWNrZXROYW1lKVxuICAgICAgYXdhaXQgdGhpcy5jaGVja0FuZFJlZnJlc2hDcmVkcygpXG4gICAgICBjb25zdCByZXFPcHRpb25zID0gdGhpcy5nZXRSZXF1ZXN0T3B0aW9ucyh7IG1ldGhvZCwgcmVnaW9uLCBidWNrZXROYW1lLCBvYmplY3ROYW1lLCBxdWVyeSB9KVxuXG4gICAgICByZXR1cm4gcHJlc2lnblNpZ25hdHVyZVY0KFxuICAgICAgICByZXFPcHRpb25zLFxuICAgICAgICB0aGlzLmFjY2Vzc0tleSxcbiAgICAgICAgdGhpcy5zZWNyZXRLZXksXG4gICAgICAgIHRoaXMuc2Vzc2lvblRva2VuLFxuICAgICAgICByZWdpb24sXG4gICAgICAgIHJlcXVlc3REYXRlLFxuICAgICAgICBleHBpcmVzLFxuICAgICAgKVxuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgaWYgKGVyciBpbnN0YW5jZW9mIGVycm9ycy5JbnZhbGlkQnVja2V0TmFtZUVycm9yKSB7XG4gICAgICAgIHRocm93IG5ldyBlcnJvcnMuSW52YWxpZEFyZ3VtZW50RXJyb3IoYFVuYWJsZSB0byBnZXQgYnVja2V0IHJlZ2lvbiBmb3IgJHtidWNrZXROYW1lfS5gKVxuICAgICAgfVxuXG4gICAgICB0aHJvdyBlcnJcbiAgICB9XG4gIH1cblxuICBhc3luYyBwcmVzaWduZWRHZXRPYmplY3QoXG4gICAgYnVja2V0TmFtZTogc3RyaW5nLFxuICAgIG9iamVjdE5hbWU6IHN0cmluZyxcbiAgICBleHBpcmVzPzogbnVtYmVyLFxuICAgIHJlc3BIZWFkZXJzPzogUHJlU2lnblJlcXVlc3RQYXJhbXMgfCBEYXRlLFxuICAgIHJlcXVlc3REYXRlPzogRGF0ZSxcbiAgKTogUHJvbWlzZTxzdHJpbmc+IHtcbiAgICBpZiAoIWlzVmFsaWRCdWNrZXROYW1lKGJ1Y2tldE5hbWUpKSB7XG4gICAgICB0aHJvdyBuZXcgZXJyb3JzLkludmFsaWRCdWNrZXROYW1lRXJyb3IoJ0ludmFsaWQgYnVja2V0IG5hbWU6ICcgKyBidWNrZXROYW1lKVxuICAgIH1cbiAgICBpZiAoIWlzVmFsaWRPYmplY3ROYW1lKG9iamVjdE5hbWUpKSB7XG4gICAgICB0aHJvdyBuZXcgZXJyb3JzLkludmFsaWRPYmplY3ROYW1lRXJyb3IoYEludmFsaWQgb2JqZWN0IG5hbWU6ICR7b2JqZWN0TmFtZX1gKVxuICAgIH1cblxuICAgIGNvbnN0IHZhbGlkUmVzcEhlYWRlcnMgPSBbXG4gICAgICAncmVzcG9uc2UtY29udGVudC10eXBlJyxcbiAgICAgICdyZXNwb25zZS1jb250ZW50LWxhbmd1YWdlJyxcbiAgICAgICdyZXNwb25zZS1leHBpcmVzJyxcbiAgICAgICdyZXNwb25zZS1jYWNoZS1jb250cm9sJyxcbiAgICAgICdyZXNwb25zZS1jb250ZW50LWRpc3Bvc2l0aW9uJyxcbiAgICAgICdyZXNwb25zZS1jb250ZW50LWVuY29kaW5nJyxcbiAgICBdXG4gICAgdmFsaWRSZXNwSGVhZGVycy5mb3JFYWNoKChoZWFkZXIpID0+IHtcbiAgICAgIC8vIEB0cy1pZ25vcmVcbiAgICAgIGlmIChyZXNwSGVhZGVycyAhPT0gdW5kZWZpbmVkICYmIHJlc3BIZWFkZXJzW2hlYWRlcl0gIT09IHVuZGVmaW5lZCAmJiAhaXNTdHJpbmcocmVzcEhlYWRlcnNbaGVhZGVyXSkpIHtcbiAgICAgICAgdGhyb3cgbmV3IFR5cGVFcnJvcihgcmVzcG9uc2UgaGVhZGVyICR7aGVhZGVyfSBzaG91bGQgYmUgb2YgdHlwZSBcInN0cmluZ1wiYClcbiAgICAgIH1cbiAgICB9KVxuICAgIHJldHVybiB0aGlzLnByZXNpZ25lZFVybCgnR0VUJywgYnVja2V0TmFtZSwgb2JqZWN0TmFtZSwgZXhwaXJlcywgcmVzcEhlYWRlcnMsIHJlcXVlc3REYXRlKVxuICB9XG5cbiAgYXN5bmMgcHJlc2lnbmVkUHV0T2JqZWN0KGJ1Y2tldE5hbWU6IHN0cmluZywgb2JqZWN0TmFtZTogc3RyaW5nLCBleHBpcmVzPzogbnVtYmVyKTogUHJvbWlzZTxzdHJpbmc+IHtcbiAgICBpZiAoIWlzVmFsaWRCdWNrZXROYW1lKGJ1Y2tldE5hbWUpKSB7XG4gICAgICB0aHJvdyBuZXcgZXJyb3JzLkludmFsaWRCdWNrZXROYW1lRXJyb3IoYEludmFsaWQgYnVja2V0IG5hbWU6ICR7YnVja2V0TmFtZX1gKVxuICAgIH1cbiAgICBpZiAoIWlzVmFsaWRPYmplY3ROYW1lKG9iamVjdE5hbWUpKSB7XG4gICAgICB0aHJvdyBuZXcgZXJyb3JzLkludmFsaWRPYmplY3ROYW1lRXJyb3IoYEludmFsaWQgb2JqZWN0IG5hbWU6ICR7b2JqZWN0TmFtZX1gKVxuICAgIH1cblxuICAgIHJldHVybiB0aGlzLnByZXNpZ25lZFVybCgnUFVUJywgYnVja2V0TmFtZSwgb2JqZWN0TmFtZSwgZXhwaXJlcylcbiAgfVxuXG4gIG5ld1Bvc3RQb2xpY3koKTogUG9zdFBvbGljeSB7XG4gICAgcmV0dXJuIG5ldyBQb3N0UG9saWN5KClcbiAgfVxuXG4gIGFzeW5jIHByZXNpZ25lZFBvc3RQb2xpY3kocG9zdFBvbGljeTogUG9zdFBvbGljeSk6IFByb21pc2U8UG9zdFBvbGljeVJlc3VsdD4ge1xuICAgIGlmICh0aGlzLmFub255bW91cykge1xuICAgICAgdGhyb3cgbmV3IGVycm9ycy5Bbm9ueW1vdXNSZXF1ZXN0RXJyb3IoJ1ByZXNpZ25lZCBQT1NUIHBvbGljeSBjYW5ub3QgYmUgZ2VuZXJhdGVkIGZvciBhbm9ueW1vdXMgcmVxdWVzdHMnKVxuICAgIH1cbiAgICBpZiAoIWlzT2JqZWN0KHBvc3RQb2xpY3kpKSB7XG4gICAgICB0aHJvdyBuZXcgVHlwZUVycm9yKCdwb3N0UG9saWN5IHNob3VsZCBiZSBvZiB0eXBlIFwib2JqZWN0XCInKVxuICAgIH1cbiAgICBjb25zdCBidWNrZXROYW1lID0gcG9zdFBvbGljeS5mb3JtRGF0YS5idWNrZXQgYXMgc3RyaW5nXG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHJlZ2lvbiA9IGF3YWl0IHRoaXMuZ2V0QnVja2V0UmVnaW9uQXN5bmMoYnVja2V0TmFtZSlcblxuICAgICAgY29uc3QgZGF0ZSA9IG5ldyBEYXRlKClcbiAgICAgIGNvbnN0IGRhdGVTdHIgPSBtYWtlRGF0ZUxvbmcoZGF0ZSlcbiAgICAgIGF3YWl0IHRoaXMuY2hlY2tBbmRSZWZyZXNoQ3JlZHMoKVxuXG4gICAgICBpZiAoIXBvc3RQb2xpY3kucG9saWN5LmV4cGlyYXRpb24pIHtcbiAgICAgICAgLy8gJ2V4cGlyYXRpb24nIGlzIG1hbmRhdG9yeSBmaWVsZCBmb3IgUzMuXG4gICAgICAgIC8vIFNldCBkZWZhdWx0IGV4cGlyYXRpb24gZGF0ZSBvZiA3IGRheXMuXG4gICAgICAgIGNvbnN0IGV4cGlyZXMgPSBuZXcgRGF0ZSgpXG4gICAgICAgIGV4cGlyZXMuc2V0U2Vjb25kcyhQUkVTSUdOX0VYUElSWV9EQVlTX01BWClcbiAgICAgICAgcG9zdFBvbGljeS5zZXRFeHBpcmVzKGV4cGlyZXMpXG4gICAgICB9XG5cbiAgICAgIHBvc3RQb2xpY3kucG9saWN5LmNvbmRpdGlvbnMucHVzaChbJ2VxJywgJyR4LWFtei1kYXRlJywgZGF0ZVN0cl0pXG4gICAgICBwb3N0UG9saWN5LmZvcm1EYXRhWyd4LWFtei1kYXRlJ10gPSBkYXRlU3RyXG5cbiAgICAgIHBvc3RQb2xpY3kucG9saWN5LmNvbmRpdGlvbnMucHVzaChbJ2VxJywgJyR4LWFtei1hbGdvcml0aG0nLCAnQVdTNC1ITUFDLVNIQTI1NiddKVxuICAgICAgcG9zdFBvbGljeS5mb3JtRGF0YVsneC1hbXotYWxnb3JpdGhtJ10gPSAnQVdTNC1ITUFDLVNIQTI1NidcblxuICAgICAgcG9zdFBvbGljeS5wb2xpY3kuY29uZGl0aW9ucy5wdXNoKFsnZXEnLCAnJHgtYW16LWNyZWRlbnRpYWwnLCB0aGlzLmFjY2Vzc0tleSArICcvJyArIGdldFNjb3BlKHJlZ2lvbiwgZGF0ZSldKVxuICAgICAgcG9zdFBvbGljeS5mb3JtRGF0YVsneC1hbXotY3JlZGVudGlhbCddID0gdGhpcy5hY2Nlc3NLZXkgKyAnLycgKyBnZXRTY29wZShyZWdpb24sIGRhdGUpXG5cbiAgICAgIGlmICh0aGlzLnNlc3Npb25Ub2tlbikge1xuICAgICAgICBwb3N0UG9saWN5LnBvbGljeS5jb25kaXRpb25zLnB1c2goWydlcScsICckeC1hbXotc2VjdXJpdHktdG9rZW4nLCB0aGlzLnNlc3Npb25Ub2tlbl0pXG4gICAgICAgIHBvc3RQb2xpY3kuZm9ybURhdGFbJ3gtYW16LXNlY3VyaXR5LXRva2VuJ10gPSB0aGlzLnNlc3Npb25Ub2tlblxuICAgICAgfVxuXG4gICAgICBjb25zdCBwb2xpY3lCYXNlNjQgPSBCdWZmZXIuZnJvbShKU09OLnN0cmluZ2lmeShwb3N0UG9saWN5LnBvbGljeSkpLnRvU3RyaW5nKCdiYXNlNjQnKVxuXG4gICAgICBwb3N0UG9saWN5LmZvcm1EYXRhLnBvbGljeSA9IHBvbGljeUJhc2U2NFxuXG4gICAgICBwb3N0UG9saWN5LmZvcm1EYXRhWyd4LWFtei1zaWduYXR1cmUnXSA9IHBvc3RQcmVzaWduU2lnbmF0dXJlVjQocmVnaW9uLCBkYXRlLCB0aGlzLnNlY3JldEtleSwgcG9saWN5QmFzZTY0KVxuICAgICAgY29uc3Qgb3B0cyA9IHtcbiAgICAgICAgcmVnaW9uOiByZWdpb24sXG4gICAgICAgIGJ1Y2tldE5hbWU6IGJ1Y2tldE5hbWUsXG4gICAgICAgIG1ldGhvZDogJ1BPU1QnLFxuICAgICAgfVxuICAgICAgY29uc3QgcmVxT3B0aW9ucyA9IHRoaXMuZ2V0UmVxdWVzdE9wdGlvbnMob3B0cylcbiAgICAgIGNvbnN0IHBvcnRTdHIgPSB0aGlzLnBvcnQgPT0gODAgfHwgdGhpcy5wb3J0ID09PSA0NDMgPyAnJyA6IGA6JHt0aGlzLnBvcnQudG9TdHJpbmcoKX1gXG4gICAgICBjb25zdCB1cmxTdHIgPSBgJHtyZXFPcHRpb25zLnByb3RvY29sfS8vJHtyZXFPcHRpb25zLmhvc3R9JHtwb3J0U3RyfSR7cmVxT3B0aW9ucy5wYXRofWBcbiAgICAgIHJldHVybiB7IHBvc3RVUkw6IHVybFN0ciwgZm9ybURhdGE6IHBvc3RQb2xpY3kuZm9ybURhdGEgfVxuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgaWYgKGVyciBpbnN0YW5jZW9mIGVycm9ycy5JbnZhbGlkQnVja2V0TmFtZUVycm9yKSB7XG4gICAgICAgIHRocm93IG5ldyBlcnJvcnMuSW52YWxpZEFyZ3VtZW50RXJyb3IoYFVuYWJsZSB0byBnZXQgYnVja2V0IHJlZ2lvbiBmb3IgJHtidWNrZXROYW1lfS5gKVxuICAgICAgfVxuXG4gICAgICB0aHJvdyBlcnJcbiAgICB9XG4gIH1cbiAgLy8gbGlzdCBhIGJhdGNoIG9mIG9iamVjdHNcbiAgYXN5bmMgbGlzdE9iamVjdHNRdWVyeShidWNrZXROYW1lOiBzdHJpbmcsIHByZWZpeD86IHN0cmluZywgbWFya2VyPzogc3RyaW5nLCBsaXN0UXVlcnlPcHRzPzogTGlzdE9iamVjdFF1ZXJ5T3B0cykge1xuICAgIGlmICghaXNWYWxpZEJ1Y2tldE5hbWUoYnVja2V0TmFtZSkpIHtcbiAgICAgIHRocm93IG5ldyBlcnJvcnMuSW52YWxpZEJ1Y2tldE5hbWVFcnJvcignSW52YWxpZCBidWNrZXQgbmFtZTogJyArIGJ1Y2tldE5hbWUpXG4gICAgfVxuICAgIGlmICghaXNTdHJpbmcocHJlZml4KSkge1xuICAgICAgdGhyb3cgbmV3IFR5cGVFcnJvcigncHJlZml4IHNob3VsZCBiZSBvZiB0eXBlIFwic3RyaW5nXCInKVxuICAgIH1cbiAgICBpZiAobWFya2VyICYmICFpc1N0cmluZyhtYXJrZXIpKSB7XG4gICAgICB0aHJvdyBuZXcgVHlwZUVycm9yKCdtYXJrZXIgc2hvdWxkIGJlIG9mIHR5cGUgXCJzdHJpbmdcIicpXG4gICAgfVxuXG4gICAgaWYgKGxpc3RRdWVyeU9wdHMgJiYgIWlzT2JqZWN0KGxpc3RRdWVyeU9wdHMpKSB7XG4gICAgICB0aHJvdyBuZXcgVHlwZUVycm9yKCdsaXN0UXVlcnlPcHRzIHNob3VsZCBiZSBvZiB0eXBlIFwib2JqZWN0XCInKVxuICAgIH1cbiAgICBsZXQgeyBEZWxpbWl0ZXIsIE1heEtleXMsIEluY2x1ZGVWZXJzaW9uLCB2ZXJzaW9uSWRNYXJrZXIsIGtleU1hcmtlciB9ID0gbGlzdFF1ZXJ5T3B0cyBhcyBMaXN0T2JqZWN0UXVlcnlPcHRzXG5cbiAgICBpZiAoIWlzU3RyaW5nKERlbGltaXRlcikpIHtcbiAgICAgIHRocm93IG5ldyBUeXBlRXJyb3IoJ0RlbGltaXRlciBzaG91bGQgYmUgb2YgdHlwZSBcInN0cmluZ1wiJylcbiAgICB9XG4gICAgaWYgKCFpc051bWJlcihNYXhLZXlzKSkge1xuICAgICAgdGhyb3cgbmV3IFR5cGVFcnJvcignTWF4S2V5cyBzaG91bGQgYmUgb2YgdHlwZSBcIm51bWJlclwiJylcbiAgICB9XG5cbiAgICBjb25zdCBxdWVyaWVzID0gW11cbiAgICAvLyBlc2NhcGUgZXZlcnkgdmFsdWUgaW4gcXVlcnkgc3RyaW5nLCBleGNlcHQgbWF4S2V5c1xuICAgIHF1ZXJpZXMucHVzaChgcHJlZml4PSR7dXJpRXNjYXBlKHByZWZpeCl9YClcbiAgICBxdWVyaWVzLnB1c2goYGRlbGltaXRlcj0ke3VyaUVzY2FwZShEZWxpbWl0ZXIpfWApXG4gICAgcXVlcmllcy5wdXNoKGBlbmNvZGluZy10eXBlPXVybGApXG5cbiAgICBpZiAoSW5jbHVkZVZlcnNpb24pIHtcbiAgICAgIHF1ZXJpZXMucHVzaChgdmVyc2lvbnNgKVxuICAgIH1cblxuICAgIGlmIChJbmNsdWRlVmVyc2lvbikge1xuICAgICAgLy8gdjEgdmVyc2lvbiBsaXN0aW5nLi5cbiAgICAgIGlmIChrZXlNYXJrZXIpIHtcbiAgICAgICAgcXVlcmllcy5wdXNoKGBrZXktbWFya2VyPSR7a2V5TWFya2VyfWApXG4gICAgICB9XG4gICAgICBpZiAodmVyc2lvbklkTWFya2VyKSB7XG4gICAgICAgIHF1ZXJpZXMucHVzaChgdmVyc2lvbi1pZC1tYXJrZXI9JHt2ZXJzaW9uSWRNYXJrZXJ9YClcbiAgICAgIH1cbiAgICB9IGVsc2UgaWYgKG1hcmtlcikge1xuICAgICAgbWFya2VyID0gdXJpRXNjYXBlKG1hcmtlcilcbiAgICAgIHF1ZXJpZXMucHVzaChgbWFya2VyPSR7bWFya2VyfWApXG4gICAgfVxuXG4gICAgLy8gbm8gbmVlZCB0byBlc2NhcGUgbWF4S2V5c1xuICAgIGlmIChNYXhLZXlzKSB7XG4gICAgICBpZiAoTWF4S2V5cyA+PSAxMDAwKSB7XG4gICAgICAgIE1heEtleXMgPSAxMDAwXG4gICAgICB9XG4gICAgICBxdWVyaWVzLnB1c2goYG1heC1rZXlzPSR7TWF4S2V5c31gKVxuICAgIH1cbiAgICBxdWVyaWVzLnNvcnQoKVxuICAgIGxldCBxdWVyeSA9ICcnXG4gICAgaWYgKHF1ZXJpZXMubGVuZ3RoID4gMCkge1xuICAgICAgcXVlcnkgPSBgJHtxdWVyaWVzLmpvaW4oJyYnKX1gXG4gICAgfVxuXG4gICAgY29uc3QgbWV0aG9kID0gJ0dFVCdcbiAgICBjb25zdCByZXMgPSBhd2FpdCB0aGlzLm1ha2VSZXF1ZXN0QXN5bmMoeyBtZXRob2QsIGJ1Y2tldE5hbWUsIHF1ZXJ5IH0pXG4gICAgY29uc3QgYm9keSA9IGF3YWl0IHJlYWRBc1N0cmluZyhyZXMpXG4gICAgY29uc3QgbGlzdFFyeUxpc3QgPSBwYXJzZUxpc3RPYmplY3RzKGJvZHkpXG4gICAgcmV0dXJuIGxpc3RRcnlMaXN0XG4gIH1cblxuICBsaXN0T2JqZWN0cyhcbiAgICBidWNrZXROYW1lOiBzdHJpbmcsXG4gICAgcHJlZml4Pzogc3RyaW5nLFxuICAgIHJlY3Vyc2l2ZT86IGJvb2xlYW4sXG4gICAgbGlzdE9wdHM/OiBMaXN0T2JqZWN0UXVlcnlPcHRzIHwgdW5kZWZpbmVkLFxuICApOiBCdWNrZXRTdHJlYW08T2JqZWN0SW5mbz4ge1xuICAgIGlmIChwcmVmaXggPT09IHVuZGVmaW5lZCkge1xuICAgICAgcHJlZml4ID0gJydcbiAgICB9XG4gICAgaWYgKHJlY3Vyc2l2ZSA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICByZWN1cnNpdmUgPSBmYWxzZVxuICAgIH1cbiAgICBpZiAoIWlzVmFsaWRCdWNrZXROYW1lKGJ1Y2tldE5hbWUpKSB7XG4gICAgICB0aHJvdyBuZXcgZXJyb3JzLkludmFsaWRCdWNrZXROYW1lRXJyb3IoJ0ludmFsaWQgYnVja2V0IG5hbWU6ICcgKyBidWNrZXROYW1lKVxuICAgIH1cbiAgICBpZiAoIWlzVmFsaWRQcmVmaXgocHJlZml4KSkge1xuICAgICAgdGhyb3cgbmV3IGVycm9ycy5JbnZhbGlkUHJlZml4RXJyb3IoYEludmFsaWQgcHJlZml4IDogJHtwcmVmaXh9YClcbiAgICB9XG4gICAgaWYgKCFpc1N0cmluZyhwcmVmaXgpKSB7XG4gICAgICB0aHJvdyBuZXcgVHlwZUVycm9yKCdwcmVmaXggc2hvdWxkIGJlIG9mIHR5cGUgXCJzdHJpbmdcIicpXG4gICAgfVxuICAgIGlmICghaXNCb29sZWFuKHJlY3Vyc2l2ZSkpIHtcbiAgICAgIHRocm93IG5ldyBUeXBlRXJyb3IoJ3JlY3Vyc2l2ZSBzaG91bGQgYmUgb2YgdHlwZSBcImJvb2xlYW5cIicpXG4gICAgfVxuICAgIGlmIChsaXN0T3B0cyAmJiAhaXNPYmplY3QobGlzdE9wdHMpKSB7XG4gICAgICB0aHJvdyBuZXcgVHlwZUVycm9yKCdsaXN0T3B0cyBzaG91bGQgYmUgb2YgdHlwZSBcIm9iamVjdFwiJylcbiAgICB9XG4gICAgbGV0IG1hcmtlcjogc3RyaW5nIHwgdW5kZWZpbmVkID0gJydcbiAgICBsZXQga2V5TWFya2VyOiBzdHJpbmcgfCB1bmRlZmluZWQgPSAnJ1xuICAgIGxldCB2ZXJzaW9uSWRNYXJrZXI6IHN0cmluZyB8IHVuZGVmaW5lZCA9ICcnXG4gICAgbGV0IG9iamVjdHM6IE9iamVjdEluZm9bXSA9IFtdXG4gICAgbGV0IGVuZGVkID0gZmFsc2VcbiAgICBjb25zdCByZWFkU3RyZWFtOiBzdHJlYW0uUmVhZGFibGUgPSBuZXcgc3RyZWFtLlJlYWRhYmxlKHsgb2JqZWN0TW9kZTogdHJ1ZSB9KVxuICAgIHJlYWRTdHJlYW0uX3JlYWQgPSBhc3luYyAoKSA9PiB7XG4gICAgICAvLyBwdXNoIG9uZSBvYmplY3QgcGVyIF9yZWFkKClcbiAgICAgIGlmIChvYmplY3RzLmxlbmd0aCkge1xuICAgICAgICByZWFkU3RyZWFtLnB1c2gob2JqZWN0cy5zaGlmdCgpKVxuICAgICAgICByZXR1cm5cbiAgICAgIH1cbiAgICAgIGlmIChlbmRlZCkge1xuICAgICAgICByZXR1cm4gcmVhZFN0cmVhbS5wdXNoKG51bGwpXG4gICAgICB9XG5cbiAgICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IGxpc3RRdWVyeU9wdHMgPSB7XG4gICAgICAgICAgRGVsaW1pdGVyOiByZWN1cnNpdmUgPyAnJyA6ICcvJywgLy8gaWYgcmVjdXJzaXZlIGlzIGZhbHNlIHNldCBkZWxpbWl0ZXIgdG8gJy8nXG4gICAgICAgICAgTWF4S2V5czogMTAwMCxcbiAgICAgICAgICBJbmNsdWRlVmVyc2lvbjogbGlzdE9wdHM/LkluY2x1ZGVWZXJzaW9uLFxuICAgICAgICAgIC8vIHZlcnNpb24gbGlzdGluZyBzcGVjaWZpYyBvcHRpb25zXG4gICAgICAgICAga2V5TWFya2VyOiBrZXlNYXJrZXIsXG4gICAgICAgICAgdmVyc2lvbklkTWFya2VyOiB2ZXJzaW9uSWRNYXJrZXIsXG4gICAgICAgIH1cblxuICAgICAgICBjb25zdCByZXN1bHQ6IExpc3RPYmplY3RRdWVyeVJlcyA9IGF3YWl0IHRoaXMubGlzdE9iamVjdHNRdWVyeShidWNrZXROYW1lLCBwcmVmaXgsIG1hcmtlciwgbGlzdFF1ZXJ5T3B0cylcbiAgICAgICAgaWYgKHJlc3VsdC5pc1RydW5jYXRlZCkge1xuICAgICAgICAgIG1hcmtlciA9IHJlc3VsdC5uZXh0TWFya2VyIHx8IHVuZGVmaW5lZFxuICAgICAgICAgIGlmIChyZXN1bHQua2V5TWFya2VyKSB7XG4gICAgICAgICAgICBrZXlNYXJrZXIgPSByZXN1bHQua2V5TWFya2VyXG4gICAgICAgICAgfVxuICAgICAgICAgIGlmIChyZXN1bHQudmVyc2lvbklkTWFya2VyKSB7XG4gICAgICAgICAgICB2ZXJzaW9uSWRNYXJrZXIgPSByZXN1bHQudmVyc2lvbklkTWFya2VyXG4gICAgICAgICAgfVxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIGVuZGVkID0gdHJ1ZVxuICAgICAgICB9XG4gICAgICAgIGlmIChyZXN1bHQub2JqZWN0cykge1xuICAgICAgICAgIG9iamVjdHMgPSByZXN1bHQub2JqZWN0c1xuICAgICAgICB9XG4gICAgICAgIC8vIEB0cy1pZ25vcmVcbiAgICAgICAgcmVhZFN0cmVhbS5fcmVhZCgpXG4gICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgcmVhZFN0cmVhbS5lbWl0KCdlcnJvcicsIGVycilcbiAgICAgIH1cbiAgICB9XG4gICAgcmV0dXJuIHJlYWRTdHJlYW1cbiAgfVxufVxuIl0sIm1hcHBpbmdzIjoiQUFBQSxPQUFPLEtBQUtBLE1BQU07QUFDbEIsT0FBTyxLQUFLQyxFQUFFO0FBRWQsT0FBTyxLQUFLQyxJQUFJO0FBQ2hCLE9BQU8sS0FBS0MsS0FBSztBQUNqQixPQUFPLEtBQUtDLElBQUk7QUFDaEIsT0FBTyxLQUFLQyxNQUFNO0FBRWxCLE9BQU8sS0FBS0MsS0FBSyxNQUFNLE9BQU87QUFDOUIsT0FBT0MsWUFBWSxNQUFNLGVBQWU7QUFDeEMsU0FBU0MsU0FBUyxRQUFRLGlCQUFpQjtBQUMzQyxPQUFPQyxDQUFDLE1BQU0sUUFBUTtBQUN0QixPQUFPLEtBQUtDLEVBQUUsTUFBTSxjQUFjO0FBQ2xDLE9BQU9DLE1BQU0sTUFBTSxRQUFRO0FBRTNCLFNBQVNDLGtCQUFrQixRQUFRLDJCQUEwQjtBQUM3RCxPQUFPLEtBQUtDLE1BQU0sTUFBTSxlQUFjO0FBRXRDLFNBQ0VDLHNCQUFzQixFQUN0QkMsaUJBQWlCLEVBQ2pCQyxjQUFjLEVBQ2RDLGlCQUFpQixFQUNqQkMsdUJBQXVCLEVBQ3ZCQyxlQUFlLEVBQ2ZDLHdCQUF3QixRQUNuQixnQkFBZTtBQUV0QixTQUFTQyxzQkFBc0IsRUFBRUMsa0JBQWtCLEVBQUVDLE1BQU0sUUFBUSxnQkFBZTtBQUNsRixTQUFTQyxHQUFH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