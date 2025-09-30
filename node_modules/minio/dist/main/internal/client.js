"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
var crypto = _interopRequireWildcard(require("crypto"), true);
var fs = _interopRequireWildcard(require("fs"), true);
var http = _interopRequireWildcard(require("http"), true);
var https = _interopRequireWildcard(require("https"), true);
var path = _interopRequireWildcard(require("path"), true);
var stream = _interopRequireWildcard(require("stream"), true);
var async = _interopRequireWildcard(require("async"), true);
var _blockStream = require("block-stream2");
var _browserOrNode = require("browser-or-node");
var _lodash = require("lodash");
var qs = _interopRequireWildcard(require("query-string"), true);
var _xml2js = require("xml2js");
var _CredentialProvider = require("../CredentialProvider.js");
var errors = _interopRequireWildcard(require("../errors.js"), true);
var _helpers = require("../helpers.js");
var _signing = require("../signing.js");
var _async2 = require("./async.js");
var _copyConditions = require("./copy-conditions.js");
var _extensions = require("./extensions.js");
var _helper = require("./helper.js");
var _joinHostPort = require("./join-host-port.js");
var _postPolicy = require("./post-policy.js");
var _request = require("./request.js");
var _response = require("./response.js");
var _s3Endpoints = require("./s3-endpoints.js");
var xmlParsers = _interopRequireWildcard(require("./xml-parser.js"), true);
function _getRequireWildcardCache(nodeInterop) { if (typeof WeakMap !== "function") return null; var cacheBabelInterop = new WeakMap(); var cacheNodeInterop = new WeakMap(); return (_getRequireWildcardCache = function (nodeInterop) { return nodeInterop ? cacheNodeInterop : cacheBabelInterop; })(nodeInterop); }
function _interopRequireWildcard(obj, nodeInterop) { if (!nodeInterop && obj && obj.__esModule) { return obj; } if (obj === null || typeof obj !== "object" && typeof obj !== "function") { return { default: obj }; } var cache = _getRequireWildcardCache(nodeInterop); if (cache && cache.has(obj)) { return cache.get(obj); } var newObj = {}; var hasPropertyDescriptor = Object.defineProperty && Object.getOwnPropertyDescriptor; for (var key in obj) { if (key !== "default" && Object.prototype.hasOwnProperty.call(obj, key)) { var desc = hasPropertyDescriptor ? Object.getOwnPropertyDescriptor(obj, key) : null; if (desc && (desc.get || desc.set)) { Object.defineProperty(newObj, key, desc); } else { newObj[key] = obj[key]; } } } newObj.default = obj; if (cache) { cache.set(obj, newObj); } return newObj; }
const xml = new _xml2js.Builder({
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
class TypedClient {
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
    if (!(0, _helper.isValidEndpoint)(params.endPoint)) {
      throw new errors.InvalidEndpointError(`Invalid endPoint : ${params.endPoint}`);
    }
    if (!(0, _helper.isValidPort)(params.port)) {
      throw new errors.InvalidArgumentError(`Invalid port : ${params.port}`);
    }
    if (!(0, _helper.isBoolean)(params.useSSL)) {
      throw new errors.InvalidArgumentError(`Invalid useSSL flag type : ${params.useSSL}, expected to be of type "boolean"`);
    }

    // Validate region only if its set.
    if (params.region) {
      if (!(0, _helper.isString)(params.region)) {
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
      if (!(0, _helper.isObject)(params.transport)) {
        throw new errors.InvalidArgumentError(`Invalid transport type : ${params.transport}, expected to be type "object"`);
      }
      transport = params.transport;
    }

    // if custom transport agent is set, use it.
    if (params.transportAgent) {
      if (!(0, _helper.isObject)(params.transportAgent)) {
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
    this.clientExtensions = new _extensions.Extensions(this);
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
    if (!(0, _helper.isObject)(options)) {
      throw new TypeError('request options should be of type "object"');
    }
    this.reqOptions = _lodash.pick(options, requestOptionProperties);
  }

  /**
   *  This is s3 Specific and does not hold validity in any other Object storage.
   */
  getAccelerateEndPointIfSet(bucketName, objectName) {
    if (!(0, _helper.isEmpty)(this.s3AccelerateEndpoint) && !(0, _helper.isEmpty)(bucketName) && !(0, _helper.isEmpty)(objectName)) {
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
    if (!(0, _helper.isString)(appName)) {
      throw new TypeError(`Invalid appName: ${appName}`);
    }
    if (appName.trim() === '') {
      throw new errors.InvalidArgumentError('Input appName cannot be empty.');
    }
    if (!(0, _helper.isString)(appVersion)) {
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
      virtualHostStyle = (0, _helper.isVirtualHostStyle)(this.host, this.protocol, bucketName, this.pathStyle);
    }
    let path = '/';
    let host = this.host;
    let port;
    if (this.port) {
      port = this.port;
    }
    if (objectName) {
      objectName = (0, _helper.uriResourceEscape)(objectName);
    }

    // For Amazon S3 endpoint, get endpoint based on region.
    if ((0, _helper.isAmazonEndpoint)(host)) {
      const accelerateEndPoint = this.getAccelerateEndPointIfSet(bucketName, objectName);
      if (accelerateEndPoint) {
        host = `${accelerateEndPoint}`;
      } else {
        host = (0, _s3Endpoints.getS3Endpoint)(region);
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
      reqOptions.headers.host = (0, _joinHostPort.joinHostPort)(host, port);
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
      headers: _lodash.mapValues(_lodash.pickBy(reqOptions.headers, _helper.isDefined), v => v.toString()),
      host,
      port,
      path
    };
  }
  async setCredentialsProvider(credentialsProvider) {
    if (!(credentialsProvider instanceof _CredentialProvider.CredentialProvider)) {
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
    if (!(0, _helper.isObject)(reqOptions)) {
      throw new TypeError('reqOptions should be of type "object"');
    }
    if (response && !(0, _helper.isReadableStream)(response)) {
      throw new TypeError('response should be of type "Stream"');
    }
    if (err && !(err instanceof Error)) {
      throw new TypeError('err should be of type "Error"');
    }
    const logStream = this.logStream;
    const logHeaders = headers => {
      Object.entries(headers).forEach(([k, v]) => {
        if (k == 'authorization') {
          if ((0, _helper.isString)(v)) {
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
    if (!(0, _helper.isObject)(options)) {
      throw new TypeError('options should be of type "object"');
    }
    if (!(0, _helper.isString)(payload) && !(0, _helper.isObject)(payload)) {
      // Buffer is of type 'object'
      throw new TypeError('payload should be of type "string" or "Buffer"');
    }
    expectedCodes.forEach(statusCode => {
      if (!(0, _helper.isNumber)(statusCode)) {
        throw new TypeError('statusCode should be of type "number"');
      }
    });
    if (!(0, _helper.isString)(region)) {
      throw new TypeError('region should be of type "string"');
    }
    if (!options.headers) {
      options.headers = {};
    }
    if (options.method === 'POST' || options.method === 'PUT' || options.method === 'DELETE') {
      options.headers['content-length'] = payload.length.toString();
    }
    const sha256sum = this.enableSHA256 ? (0, _helper.toSha256)(payload) : '';
    return this.makeRequestStreamAsync(options, payload, sha256sum, expectedCodes, region);
  }

  /**
   * new request with promise
   *
   * No need to drain response, response body is not valid
   */
  async makeRequestAsyncOmit(options, payload = '', statusCodes = [200], region = '') {
    const res = await this.makeRequestAsync(options, payload, statusCodes, region);
    await (0, _response.drainResponse)(res);
    return res;
  }

  /**
   * makeRequestStream will be used directly instead of makeRequest in case the payload
   * is available as a stream. for ex. putObject
   *
   * @internal
   */
  async makeRequestStreamAsync(options, body, sha256sum, statusCodes, region) {
    if (!(0, _helper.isObject)(options)) {
      throw new TypeError('options should be of type "object"');
    }
    if (!(Buffer.isBuffer(body) || typeof body === 'string' || (0, _helper.isReadableStream)(body))) {
      throw new errors.InvalidArgumentError(`stream should be a Buffer, string or readable Stream, got ${typeof body} instead`);
    }
    if (!(0, _helper.isString)(sha256sum)) {
      throw new TypeError('sha256sum should be of type "string"');
    }
    statusCodes.forEach(statusCode => {
      if (!(0, _helper.isNumber)(statusCode)) {
        throw new TypeError('statusCode should be of type "number"');
      }
    });
    if (!(0, _helper.isString)(region)) {
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
      reqOptions.headers['x-amz-date'] = (0, _helper.makeDateLong)(date);
      reqOptions.headers['x-amz-content-sha256'] = sha256sum;
      if (this.sessionToken) {
        reqOptions.headers['x-amz-security-token'] = this.sessionToken;
      }
      reqOptions.headers.authorization = (0, _signing.signV4)(reqOptions, this.accessKey, this.secretKey, region, date, sha256sum);
    }
    const response = await (0, _request.requestWithRetry)(this.transport, reqOptions, body);
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
    if (!(0, _helper.isValidBucketName)(bucketName)) {
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
      const body = await (0, _response.readAsString)(response);
      const region = xmlParsers.parseBucketRegion(body) || _helpers.DEFAULT_REGION;
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
    const pathStyle = this.pathStyle && !_browserOrNode.isBrowser;
    let region;
    try {
      const res = await this.makeRequestAsync({
        method,
        bucketName,
        query,
        pathStyle
      }, '', [200], _helpers.DEFAULT_REGION);
      return extractRegionAsync(res);
    } catch (e) {
      // make alignment with mc cli
      if (e instanceof errors.S3Error) {
        const errCode = e.code;
        const errRegion = e.region;
        if (errCode === 'AccessDenied' && !errRegion) {
          return _helpers.DEFAULT_REGION;
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
        await (0, _response.drainResponse)(res);
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
    if (!(0, _helper.isValidBucketName)(bucketName)) {
      throw new errors.InvalidBucketNameError('Invalid bucket name: ' + bucketName);
    }
    // Backward Compatibility
    if ((0, _helper.isObject)(region)) {
      makeOpts = region;
      region = '';
    }
    if (!(0, _helper.isString)(region)) {
      throw new TypeError('region should be of type "string"');
    }
    if (makeOpts && !(0, _helper.isObject)(makeOpts)) {
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
    if (region && region !== _helpers.DEFAULT_REGION) {
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
    const finalRegion = this.region || region || _helpers.DEFAULT_REGION;
    const requestOpt = {
      method,
      bucketName,
      headers
    };
    try {
      await this.makeRequestAsyncOmit(requestOpt, payload, [200], finalRegion);
    } catch (err) {
      if (region === '' || region === _helpers.DEFAULT_REGION) {
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
    if (!(0, _helper.isValidBucketName)(bucketName)) {
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
    if (!(0, _helper.isValidBucketName)(bucketName)) {
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
    if (!(0, _helper.isValidBucketName)(bucketName)) {
      throw new errors.InvalidBucketNameError('Invalid bucket name: ' + bucketName);
    }
    if (!(0, _helper.isValidObjectName)(objectName)) {
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
    if (!(0, _helper.isValidBucketName)(bucketName)) {
      throw new errors.InvalidBucketNameError('Invalid bucket name: ' + bucketName);
    }
    if (!(0, _helper.isValidObjectName)(objectName)) {
      throw new errors.InvalidObjectNameError(`Invalid object name: ${objectName}`);
    }
    if (!(0, _helper.isNumber)(offset)) {
      throw new TypeError('offset should be of type "number"');
    }
    if (!(0, _helper.isNumber)(length)) {
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
        ...(0, _helper.prependXAMZMeta)(sseHeaders),
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
    if (!(0, _helper.isValidBucketName)(bucketName)) {
      throw new errors.InvalidBucketNameError('Invalid bucket name: ' + bucketName);
    }
    if (!(0, _helper.isValidObjectName)(objectName)) {
      throw new errors.InvalidObjectNameError(`Invalid object name: ${objectName}`);
    }
    if (!(0, _helper.isString)(filePath)) {
      throw new TypeError('filePath should be of type "string"');
    }
    const downloadToTmpFile = async () => {
      let partFileStream;
      const objStat = await this.statObject(bucketName, objectName, getOpts);
      const encodedEtag = Buffer.from(objStat.etag).toString('base64');
      const partFile = `${filePath}.${encodedEtag}.part.minio`;
      await _async2.fsp.mkdir(path.dirname(filePath), {
        recursive: true
      });
      let offset = 0;
      try {
        const stats = await _async2.fsp.stat(partFile);
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
      await _async2.streamPromise.pipeline(downloadStream, partFileStream);
      const stats = await _async2.fsp.stat(partFile);
      if (stats.size === objStat.size) {
        return partFile;
      }
      throw new Error('Size mismatch between downloaded file and the object');
    };
    const partFile = await downloadToTmpFile();
    await _async2.fsp.rename(partFile, filePath);
  }

  /**
   * Stat information of the object.
   */
  async statObject(bucketName, objectName, statOpts) {
    const statOptDef = statOpts || {};
    if (!(0, _helper.isValidBucketName)(bucketName)) {
      throw new errors.InvalidBucketNameError('Invalid bucket name: ' + bucketName);
    }
    if (!(0, _helper.isValidObjectName)(objectName)) {
      throw new errors.InvalidObjectNameError(`Invalid object name: ${objectName}`);
    }
    if (!(0, _helper.isObject)(statOptDef)) {
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
      metaData: (0, _helper.extractMetadata)(res.headers),
      lastModified: new Date(res.headers['last-modified']),
      versionId: (0, _helper.getVersionId)(res.headers),
      etag: (0, _helper.sanitizeETag)(res.headers.etag)
    };
  }
  async removeObject(bucketName, objectName, removeOpts) {
    if (!(0, _helper.isValidBucketName)(bucketName)) {
      throw new errors.InvalidBucketNameError(`Invalid bucket name: ${bucketName}`);
    }
    if (!(0, _helper.isValidObjectName)(objectName)) {
      throw new errors.InvalidObjectNameError(`Invalid object name: ${objectName}`);
    }
    if (removeOpts && !(0, _helper.isObject)(removeOpts)) {
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
    if (!(0, _helper.isValidBucketName)(bucket)) {
      throw new errors.InvalidBucketNameError('Invalid bucket name: ' + bucket);
    }
    if (!(0, _helper.isValidPrefix)(prefix)) {
      throw new errors.InvalidPrefixError(`Invalid prefix : ${prefix}`);
    }
    if (!(0, _helper.isBoolean)(recursive)) {
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
    if (!(0, _helper.isValidBucketName)(bucketName)) {
      throw new errors.InvalidBucketNameError('Invalid bucket name: ' + bucketName);
    }
    if (!(0, _helper.isString)(prefix)) {
      throw new TypeError('prefix should be of type "string"');
    }
    if (!(0, _helper.isString)(keyMarker)) {
      throw new TypeError('keyMarker should be of type "string"');
    }
    if (!(0, _helper.isString)(uploadIdMarker)) {
      throw new TypeError('uploadIdMarker should be of type "string"');
    }
    if (!(0, _helper.isString)(delimiter)) {
      throw new TypeError('delimiter should be of type "string"');
    }
    const queries = [];
    queries.push(`prefix=${(0, _helper.uriEscape)(prefix)}`);
    queries.push(`delimiter=${(0, _helper.uriEscape)(delimiter)}`);
    if (keyMarker) {
      queries.push(`key-marker=${(0, _helper.uriEscape)(keyMarker)}`);
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
    const body = await (0, _response.readAsString)(res);
    return xmlParsers.parseListMultipart(body);
  }

  /**
   * Initiate a new multipart upload.
   * @internal
   */
  async initiateNewMultipartUpload(bucketName, objectName, headers) {
    if (!(0, _helper.isValidBucketName)(bucketName)) {
      throw new errors.InvalidBucketNameError('Invalid bucket name: ' + bucketName);
    }
    if (!(0, _helper.isValidObjectName)(objectName)) {
      throw new errors.InvalidObjectNameError(`Invalid object name: ${objectName}`);
    }
    if (!(0, _helper.isObject)(headers)) {
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
    const body = await (0, _response.readAsBuffer)(res);
    return (0, xmlParsers.parseInitiateMultipart)(body.toString());
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
    if (!(0, _helper.isValidBucketName)(bucketName)) {
      throw new errors.InvalidBucketNameError('Invalid bucket name: ' + bucketName);
    }
    if (!(0, _helper.isValidObjectName)(objectName)) {
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
    if (!(0, _helper.isValidBucketName)(bucketName)) {
      throw new errors.InvalidBucketNameError('Invalid bucket name: ' + bucketName);
    }
    if (!(0, _helper.isValidObjectName)(objectName)) {
      throw new errors.InvalidObjectNameError(`Invalid object name: ${objectName}`);
    }
    if (!(0, _helper.isString)(uploadId)) {
      throw new TypeError('uploadId should be of type "string"');
    }
    if (!(0, _helper.isObject)(etags)) {
      throw new TypeError('etags should be of type "Array"');
    }
    if (!uploadId) {
      throw new errors.InvalidArgumentError('uploadId cannot be empty');
    }
    const method = 'POST';
    const query = `uploadId=${(0, _helper.uriEscape)(uploadId)}`;
    const builder = new _xml2js.Builder();
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
    const body = await (0, _response.readAsBuffer)(res);
    const result = (0, xmlParsers.parseCompleteMultipart)(body.toString());
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
      versionId: (0, _helper.getVersionId)(res.headers)
    };
  }

  /**
   * Get part-info of all parts of an incomplete upload specified by uploadId.
   */
  async listParts(bucketName, objectName, uploadId) {
    if (!(0, _helper.isValidBucketName)(bucketName)) {
      throw new errors.InvalidBucketNameError('Invalid bucket name: ' + bucketName);
    }
    if (!(0, _helper.isValidObjectName)(objectName)) {
      throw new errors.InvalidObjectNameError(`Invalid object name: ${objectName}`);
    }
    if (!(0, _helper.isString)(uploadId)) {
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
    if (!(0, _helper.isValidBucketName)(bucketName)) {
      throw new errors.InvalidBucketNameError('Invalid bucket name: ' + bucketName);
    }
    if (!(0, _helper.isValidObjectName)(objectName)) {
      throw new errors.InvalidObjectNameError(`Invalid object name: ${objectName}`);
    }
    if (!(0, _helper.isString)(uploadId)) {
      throw new TypeError('uploadId should be of type "string"');
    }
    if (!(0, _helper.isNumber)(marker)) {
      throw new TypeError('marker should be of type "number"');
    }
    if (!uploadId) {
      throw new errors.InvalidArgumentError('uploadId cannot be empty');
    }
    let query = `uploadId=${(0, _helper.uriEscape)(uploadId)}`;
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
    return xmlParsers.parseListParts(await (0, _response.readAsString)(res));
  }
  async listBuckets() {
    const method = 'GET';
    const regionConf = this.region || _helpers.DEFAULT_REGION;
    const httpRes = await this.makeRequestAsync({
      method
    }, '', [200], regionConf);
    const xmlResult = await (0, _response.readAsString)(httpRes);
    return xmlParsers.parseListBucket(xmlResult);
  }

  /**
   * Calculate part size given the object size. Part size will be atleast this.partSize
   */
  calculatePartSize(size) {
    if (!(0, _helper.isNumber)(size)) {
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
    if (!(0, _helper.isValidBucketName)(bucketName)) {
      throw new errors.InvalidBucketNameError('Invalid bucket name: ' + bucketName);
    }
    if (!(0, _helper.isValidObjectName)(objectName)) {
      throw new errors.InvalidObjectNameError(`Invalid object name: ${objectName}`);
    }
    if (!(0, _helper.isString)(filePath)) {
      throw new TypeError('filePath should be of type "string"');
    }
    if (metaData && !(0, _helper.isObject)(metaData)) {
      throw new TypeError('metaData should be of type "object"');
    }

    // Inserts correct `content-type` attribute based on metaData and filePath
    metaData = (0, _helper.insertContentType)(metaData || {}, filePath);
    const stat = await _async2.fsp.stat(filePath);
    return await this.putObject(bucketName, objectName, fs.createReadStream(filePath), stat.size, metaData);
  }

  /**
   *  Uploading a stream, "Buffer" or "string".
   *  It's recommended to pass `size` argument with stream.
   */
  async putObject(bucketName, objectName, stream, size, metaData) {
    if (!(0, _helper.isValidBucketName)(bucketName)) {
      throw new errors.InvalidBucketNameError(`Invalid bucket name: ${bucketName}`);
    }
    if (!(0, _helper.isValidObjectName)(objectName)) {
      throw new errors.InvalidObjectNameError(`Invalid object name: ${objectName}`);
    }

    // We'll need to shift arguments to the left because of metaData
    // and size being optional.
    if ((0, _helper.isObject)(size)) {
      metaData = size;
    }
    // Ensures Metadata has appropriate prefix for A3 API
    const headers = (0, _helper.prependXAMZMeta)(metaData);
    if (typeof stream === 'string' || stream instanceof Buffer) {
      // Adapts the non-stream interface into a stream.
      size = stream.length;
      stream = (0, _helper.readableStream)(stream);
    } else if (!(0, _helper.isReadableStream)(stream)) {
      throw new TypeError('third argument should be of type "stream.Readable" or "Buffer" or "string"');
    }
    if ((0, _helper.isNumber)(size) && size < 0) {
      throw new errors.InvalidArgumentError(`size cannot be negative, given size: ${size}`);
    }

    // Get the part size and forward that to the BlockStream. Default to the
    // largest block size possible if necessary.
    if (!(0, _helper.isNumber)(size)) {
      size = this.maxObjectSize;
    }

    // Get the part size and forward that to the BlockStream. Default to the
    // largest block size possible if necessary.
    if (size === undefined) {
      const statSize = await (0, _helper.getContentLength)(stream);
      if (statSize !== null) {
        size = statSize;
      }
    }
    if (!(0, _helper.isNumber)(size)) {
      // Backward compatibility
      size = this.maxObjectSize;
    }
    if (size === 0) {
      return this.uploadBuffer(bucketName, objectName, headers, Buffer.from(''));
    }
    const partSize = this.calculatePartSize(size);
    if (typeof stream === 'string' || Buffer.isBuffer(stream) || size <= partSize) {
      const buf = (0, _helper.isReadableStream)(stream) ? await (0, _response.readAsBuffer)(stream) : Buffer.from(stream);
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
    } = (0, _helper.hashBinary)(buf, this.enableSHA256);
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
    await (0, _response.drainResponse)(res);
    return {
      etag: (0, _helper.sanitizeETag)(res.headers.etag),
      versionId: (0, _helper.getVersionId)(res.headers)
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
    const chunkier = new _blockStream({
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
    if (!(0, _helper.isValidBucketName)(bucketName)) {
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
    if (!(0, _helper.isValidBucketName)(bucketName)) {
      throw new errors.InvalidBucketNameError('Invalid bucket name: ' + bucketName);
    }
    if (!(0, _helper.isObject)(replicationConfig)) {
      throw new errors.InvalidArgumentError('replicationConfig should be of type "object"');
    } else {
      if (_lodash.isEmpty(replicationConfig.role)) {
        throw new errors.InvalidArgumentError('Role cannot be empty');
      } else if (replicationConfig.role && !(0, _helper.isString)(replicationConfig.role)) {
        throw new errors.InvalidArgumentError('Invalid value for role', replicationConfig.role);
      }
      if (_lodash.isEmpty(replicationConfig.rules)) {
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
    const builder = new _xml2js.Builder({
      renderOpts: {
        pretty: false
      },
      headless: true
    });
    const payload = builder.buildObject(replicationParamsConfig);
    headers['Content-MD5'] = (0, _helper.toMd5)(payload);
    await this.makeRequestAsyncOmit({
      method,
      bucketName,
      query,
      headers
    }, payload);
  }
  async getBucketReplication(bucketName) {
    if (!(0, _helper.isValidBucketName)(bucketName)) {
      throw new errors.InvalidBucketNameError('Invalid bucket name: ' + bucketName);
    }
    const method = 'GET';
    const query = 'replication';
    const httpRes = await this.makeRequestAsync({
      method,
      bucketName,
      query
    }, '', [200, 204]);
    const xmlResult = await (0, _response.readAsString)(httpRes);
    return xmlParsers.parseReplicationConfig(xmlResult);
  }
  async getObjectLegalHold(bucketName, objectName, getOpts) {
    if (!(0, _helper.isValidBucketName)(bucketName)) {
      throw new errors.InvalidBucketNameError('Invalid bucket name: ' + bucketName);
    }
    if (!(0, _helper.isValidObjectName)(objectName)) {
      throw new errors.InvalidObjectNameError(`Invalid object name: ${objectName}`);
    }
    if (getOpts) {
      if (!(0, _helper.isObject)(getOpts)) {
        throw new TypeError('getOpts should be of type "Object"');
      } else if (Object.keys(getOpts).length > 0 && getOpts.versionId && !(0, _helper.isString)(getOpts.versionId)) {
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
    const strRes = await (0, _response.readAsString)(httpRes);
    return (0, xmlParsers.parseObjectLegalHoldConfig)(strRes);
  }
  async setObjectLegalHold(bucketName, objectName, setOpts = {
    status: _helpers.LEGAL_HOLD_STATUS.ENABLED
  }) {
    if (!(0, _helper.isValidBucketName)(bucketName)) {
      throw new errors.InvalidBucketNameError('Invalid bucket name: ' + bucketName);
    }
    if (!(0, _helper.isValidObjectName)(objectName)) {
      throw new errors.InvalidObjectNameError(`Invalid object name: ${objectName}`);
    }
    if (!(0, _helper.isObject)(setOpts)) {
      throw new TypeError('setOpts should be of type "Object"');
    } else {
      if (![_helpers.LEGAL_HOLD_STATUS.ENABLED, _helpers.LEGAL_HOLD_STATUS.DISABLED].includes(setOpts === null || setOpts === void 0 ? void 0 : setOpts.status)) {
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
    const builder = new _xml2js.Builder({
      rootName: 'LegalHold',
      renderOpts: {
        pretty: false
      },
      headless: true
    });
    const payload = builder.buildObject(config);
    const headers = {};
    headers['Content-MD5'] = (0, _helper.toMd5)(payload);
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
    if (!(0, _helper.isValidBucketName)(bucketName)) {
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
    const body = await (0, _response.readAsString)(response);
    return xmlParsers.parseTagging(body);
  }

  /**
   *  Get the tags associated with a bucket OR an object
   */
  async getObjectTagging(bucketName, objectName, getOpts) {
    const method = 'GET';
    let query = 'tagging';
    if (!(0, _helper.isValidBucketName)(bucketName)) {
      throw new errors.InvalidBucketNameError('Invalid bucket name: ' + bucketName);
    }
    if (!(0, _helper.isValidObjectName)(objectName)) {
      throw new errors.InvalidBucketNameError('Invalid object name: ' + objectName);
    }
    if (getOpts && !(0, _helper.isObject)(getOpts)) {
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
    const body = await (0, _response.readAsString)(response);
    return xmlParsers.parseTagging(body);
  }

  /**
   *  Set the policy on a bucket or an object prefix.
   */
  async setBucketPolicy(bucketName, policy) {
    // Validate arguments.
    if (!(0, _helper.isValidBucketName)(bucketName)) {
      throw new errors.InvalidBucketNameError(`Invalid bucket name: ${bucketName}`);
    }
    if (!(0, _helper.isString)(policy)) {
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
    if (!(0, _helper.isValidBucketName)(bucketName)) {
      throw new errors.InvalidBucketNameError(`Invalid bucket name: ${bucketName}`);
    }
    const method = 'GET';
    const query = 'policy';
    const res = await this.makeRequestAsync({
      method,
      bucketName,
      query
    });
    return await (0, _response.readAsString)(res);
  }
  async putObjectRetention(bucketName, objectName, retentionOpts = {}) {
    if (!(0, _helper.isValidBucketName)(bucketName)) {
      throw new errors.InvalidBucketNameError(`Invalid bucket name: ${bucketName}`);
    }
    if (!(0, _helper.isValidObjectName)(objectName)) {
      throw new errors.InvalidObjectNameError(`Invalid object name: ${objectName}`);
    }
    if (!(0, _helper.isObject)(retentionOpts)) {
      throw new errors.InvalidArgumentError('retentionOpts should be of type "object"');
    } else {
      if (retentionOpts.governanceBypass && !(0, _helper.isBoolean)(retentionOpts.governanceBypass)) {
        throw new errors.InvalidArgumentError(`Invalid value for governanceBypass: ${retentionOpts.governanceBypass}`);
      }
      if (retentionOpts.mode && ![_helpers.RETENTION_MODES.COMPLIANCE, _helpers.RETENTION_MODES.GOVERNANCE].includes(retentionOpts.mode)) {
        throw new errors.InvalidArgumentError(`Invalid object retention mode: ${retentionOpts.mode}`);
      }
      if (retentionOpts.retainUntilDate && !(0, _helper.isString)(retentionOpts.retainUntilDate)) {
        throw new errors.InvalidArgumentError(`Invalid value for retainUntilDate: ${retentionOpts.retainUntilDate}`);
      }
      if (retentionOpts.versionId && !(0, _helper.isString)(retentionOpts.versionId)) {
        throw new errors.InvalidArgumentError(`Invalid value for versionId: ${retentionOpts.versionId}`);
      }
    }
    const method = 'PUT';
    let query = 'retention';
    const headers = {};
    if (retentionOpts.governanceBypass) {
      headers['X-Amz-Bypass-Governance-Retention'] = true;
    }
    const builder = new _xml2js.Builder({
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
    headers['Content-MD5'] = (0, _helper.toMd5)(payload);
    await this.makeRequestAsyncOmit({
      method,
      bucketName,
      objectName,
      query,
      headers
    }, payload, [200, 204]);
  }
  async getObjectLockConfig(bucketName) {
    if (!(0, _helper.isValidBucketName)(bucketName)) {
      throw new errors.InvalidBucketNameError('Invalid bucket name: ' + bucketName);
    }
    const method = 'GET';
    const query = 'object-lock';
    const httpRes = await this.makeRequestAsync({
      method,
      bucketName,
      query
    });
    const xmlResult = await (0, _response.readAsString)(httpRes);
    return xmlParsers.parseObjectLockConfig(xmlResult);
  }
  async setObjectLockConfig(bucketName, lockConfigOpts) {
    const retentionModes = [_helpers.RETENTION_MODES.COMPLIANCE, _helpers.RETENTION_MODES.GOVERNANCE];
    const validUnits = [_helpers.RETENTION_VALIDITY_UNITS.DAYS, _helpers.RETENTION_VALIDITY_UNITS.YEARS];
    if (!(0, _helper.isValidBucketName)(bucketName)) {
      throw new errors.InvalidBucketNameError('Invalid bucket name: ' + bucketName);
    }
    if (lockConfigOpts.mode && !retentionModes.includes(lockConfigOpts.mode)) {
      throw new TypeError(`lockConfigOpts.mode should be one of ${retentionModes}`);
    }
    if (lockConfigOpts.unit && !validUnits.includes(lockConfigOpts.unit)) {
      throw new TypeError(`lockConfigOpts.unit should be one of ${validUnits}`);
    }
    if (lockConfigOpts.validity && !(0, _helper.isNumber)(lockConfigOpts.validity)) {
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
        if (lockConfigOpts.unit === _helpers.RETENTION_VALIDITY_UNITS.DAYS) {
          config.Rule.DefaultRetention.Days = lockConfigOpts.validity;
        } else if (lockConfigOpts.unit === _helpers.RETENTION_VALIDITY_UNITS.YEARS) {
          config.Rule.DefaultRetention.Years = lockConfigOpts.validity;
        }
      }
    }
    const builder = new _xml2js.Builder({
      rootName: 'ObjectLockConfiguration',
      renderOpts: {
        pretty: false
      },
      headless: true
    });
    const payload = builder.buildObject(config);
    const headers = {};
    headers['Content-MD5'] = (0, _helper.toMd5)(payload);
    await this.makeRequestAsyncOmit({
      method,
      bucketName,
      query,
      headers
    }, payload);
  }
  async getBucketVersioning(bucketName) {
    if (!(0, _helper.isValidBucketName)(bucketName)) {
      throw new errors.InvalidBucketNameError('Invalid bucket name: ' + bucketName);
    }
    const method = 'GET';
    const query = 'versioning';
    const httpRes = await this.makeRequestAsync({
      method,
      bucketName,
      query
    });
    const xmlResult = await (0, _response.readAsString)(httpRes);
    return await xmlParsers.parseBucketVersioningConfig(xmlResult);
  }
  async setBucketVersioning(bucketName, versionConfig) {
    if (!(0, _helper.isValidBucketName)(bucketName)) {
      throw new errors.InvalidBucketNameError('Invalid bucket name: ' + bucketName);
    }
    if (!Object.keys(versionConfig).length) {
      throw new errors.InvalidArgumentError('versionConfig should be of type "object"');
    }
    const method = 'PUT';
    const query = 'versioning';
    const builder = new _xml2js.Builder({
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
    const builder = new _xml2js.Builder({
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
    headers['Content-MD5'] = (0, _helper.toMd5)(payloadBuf);
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
    if (!(0, _helper.isValidBucketName)(bucketName)) {
      throw new errors.InvalidBucketNameError('Invalid bucket name: ' + bucketName);
    }
    if (!(0, _helper.isPlainObject)(tags)) {
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
    if (!(0, _helper.isValidBucketName)(bucketName)) {
      throw new errors.InvalidBucketNameError('Invalid bucket name: ' + bucketName);
    }
    await this.removeTagging({
      bucketName
    });
  }
  async setObjectTagging(bucketName, objectName, tags, putOpts) {
    if (!(0, _helper.isValidBucketName)(bucketName)) {
      throw new errors.InvalidBucketNameError('Invalid bucket name: ' + bucketName);
    }
    if (!(0, _helper.isValidObjectName)(objectName)) {
      throw new errors.InvalidBucketNameError('Invalid object name: ' + objectName);
    }
    if (!(0, _helper.isPlainObject)(tags)) {
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
    if (!(0, _helper.isValidBucketName)(bucketName)) {
      throw new errors.InvalidBucketNameError('Invalid bucket name: ' + bucketName);
    }
    if (!(0, _helper.isValidObjectName)(objectName)) {
      throw new errors.InvalidBucketNameError('Invalid object name: ' + objectName);
    }
    if (removeOpts && Object.keys(removeOpts).length && !(0, _helper.isObject)(removeOpts)) {
      throw new errors.InvalidArgumentError('removeOpts should be of type "object"');
    }
    await this.removeTagging({
      bucketName,
      objectName,
      removeOpts
    });
  }
  async selectObjectContent(bucketName, objectName, selectOpts) {
    if (!(0, _helper.isValidBucketName)(bucketName)) {
      throw new errors.InvalidBucketNameError(`Invalid bucket name: ${bucketName}`);
    }
    if (!(0, _helper.isValidObjectName)(objectName)) {
      throw new errors.InvalidObjectNameError(`Invalid object name: ${objectName}`);
    }
    if (!_lodash.isEmpty(selectOpts)) {
      if (!(0, _helper.isString)(selectOpts.expression)) {
        throw new TypeError('sqlExpression should be of type "string"');
      }
      if (!_lodash.isEmpty(selectOpts.inputSerialization)) {
        if (!(0, _helper.isObject)(selectOpts.inputSerialization)) {
          throw new TypeError('inputSerialization should be of type "object"');
        }
      } else {
        throw new TypeError('inputSerialization is required');
      }
      if (!_lodash.isEmpty(selectOpts.outputSerialization)) {
        if (!(0, _helper.isObject)(selectOpts.outputSerialization)) {
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
    const builder = new _xml2js.Builder({
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
    const body = await (0, _response.readAsBuffer)(res);
    return (0, xmlParsers.parseSelectObjectContentResponse)(body);
  }
  async applyBucketLifecycle(bucketName, policyConfig) {
    const method = 'PUT';
    const query = 'lifecycle';
    const headers = {};
    const builder = new _xml2js.Builder({
      rootName: 'LifecycleConfiguration',
      headless: true,
      renderOpts: {
        pretty: false
      }
    });
    const payload = builder.buildObject(policyConfig);
    headers['Content-MD5'] = (0, _helper.toMd5)(payload);
    await this.makeRequestAsyncOmit({
      method,
      bucketName,
      query,
      headers
    }, payload);
  }
  async removeBucketLifecycle(bucketName) {
    if (!(0, _helper.isValidBucketName)(bucketName)) {
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
    if (!(0, _helper.isValidBucketName)(bucketName)) {
      throw new errors.InvalidBucketNameError('Invalid bucket name: ' + bucketName);
    }
    if (_lodash.isEmpty(lifeCycleConfig)) {
      await this.removeBucketLifecycle(bucketName);
    } else {
      await this.applyBucketLifecycle(bucketName, lifeCycleConfig);
    }
  }
  async getBucketLifecycle(bucketName) {
    if (!(0, _helper.isValidBucketName)(bucketName)) {
      throw new errors.InvalidBucketNameError('Invalid bucket name: ' + bucketName);
    }
    const method = 'GET';
    const query = 'lifecycle';
    const res = await this.makeRequestAsync({
      method,
      bucketName,
      query
    });
    const body = await (0, _response.readAsString)(res);
    return xmlParsers.parseLifecycleConfig(body);
  }
  async setBucketEncryption(bucketName, encryptionConfig) {
    if (!(0, _helper.isValidBucketName)(bucketName)) {
      throw new errors.InvalidBucketNameError('Invalid bucket name: ' + bucketName);
    }
    if (!_lodash.isEmpty(encryptionConfig) && encryptionConfig.Rule.length > 1) {
      throw new errors.InvalidArgumentError('Invalid Rule length. Only one rule is allowed.: ' + encryptionConfig.Rule);
    }
    let encryptionObj = encryptionConfig;
    if (_lodash.isEmpty(encryptionConfig)) {
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
    const builder = new _xml2js.Builder({
      rootName: 'ServerSideEncryptionConfiguration',
      renderOpts: {
        pretty: false
      },
      headless: true
    });
    const payload = builder.buildObject(encryptionObj);
    const headers = {};
    headers['Content-MD5'] = (0, _helper.toMd5)(payload);
    await this.makeRequestAsyncOmit({
      method,
      bucketName,
      query,
      headers
    }, payload);
  }
  async getBucketEncryption(bucketName) {
    if (!(0, _helper.isValidBucketName)(bucketName)) {
      throw new errors.InvalidBucketNameError('Invalid bucket name: ' + bucketName);
    }
    const method = 'GET';
    const query = 'encryption';
    const res = await this.makeRequestAsync({
      method,
      bucketName,
      query
    });
    const body = await (0, _response.readAsString)(res);
    return xmlParsers.parseBucketEncryptionConfig(body);
  }
  async removeBucketEncryption(bucketName) {
    if (!(0, _helper.isValidBucketName)(bucketName)) {
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
    if (!(0, _helper.isValidBucketName)(bucketName)) {
      throw new errors.InvalidBucketNameError('Invalid bucket name: ' + bucketName);
    }
    if (!(0, _helper.isValidObjectName)(objectName)) {
      throw new errors.InvalidObjectNameError(`Invalid object name: ${objectName}`);
    }
    if (getOpts && !(0, _helper.isObject)(getOpts)) {
      throw new errors.InvalidArgumentError('getOpts should be of type "object"');
    } else if (getOpts !== null && getOpts !== void 0 && getOpts.versionId && !(0, _helper.isString)(getOpts.versionId)) {
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
    const body = await (0, _response.readAsString)(res);
    return xmlParsers.parseObjectRetentionConfig(body);
  }
  async removeObjects(bucketName, objectsList) {
    if (!(0, _helper.isValidBucketName)(bucketName)) {
      throw new errors.InvalidBucketNameError('Invalid bucket name: ' + bucketName);
    }
    if (!Array.isArray(objectsList)) {
      throw new errors.InvalidArgumentError('objectsList should be a list');
    }
    const runDeleteObjects = async batch => {
      const delObjects = batch.map(value => {
        return (0, _helper.isObject)(value) ? {
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
      const payload = Buffer.from(new _xml2js.Builder({
        headless: true
      }).buildObject(remObjects));
      const headers = {
        'Content-MD5': (0, _helper.toMd5)(payload)
      };
      const res = await this.makeRequestAsync({
        method: 'POST',
        bucketName,
        query: 'delete',
        headers
      }, payload);
      const body = await (0, _response.readAsString)(res);
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
    if (!(0, _helper.isValidBucketName)(bucketName)) {
      throw new errors.IsValidBucketNameError('Invalid bucket name: ' + bucketName);
    }
    if (!(0, _helper.isValidObjectName)(objectName)) {
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
    if (!(0, _helper.isValidBucketName)(targetBucketName)) {
      throw new errors.InvalidBucketNameError('Invalid bucket name: ' + targetBucketName);
    }
    if (!(0, _helper.isValidObjectName)(targetObjectName)) {
      throw new errors.InvalidObjectNameError(`Invalid object name: ${targetObjectName}`);
    }
    if (!(0, _helper.isString)(sourceBucketNameAndObjectName)) {
      throw new TypeError('sourceBucketNameAndObjectName should be of type "string"');
    }
    if (sourceBucketNameAndObjectName === '') {
      throw new errors.InvalidPrefixError(`Empty source prefix`);
    }
    if (conditions != null && !(conditions instanceof _copyConditions.CopyConditions)) {
      throw new TypeError('conditions should be of type "CopyConditions"');
    }
    const headers = {};
    headers['x-amz-copy-source'] = (0, _helper.uriResourceEscape)(sourceBucketNameAndObjectName);
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
    const body = await (0, _response.readAsString)(res);
    return xmlParsers.parseCopyObject(body);
  }
  async copyObjectV2(sourceConfig, destConfig) {
    if (!(sourceConfig instanceof _helpers.CopySourceOptions)) {
      throw new errors.InvalidArgumentError('sourceConfig should of type CopySourceOptions ');
    }
    if (!(destConfig instanceof _helpers.CopyDestinationOptions)) {
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
    const body = await (0, _response.readAsString)(res);
    const copyRes = xmlParsers.parseCopyObject(body);
    const resHeaders = res.headers;
    const sizeHeaderValue = resHeaders && resHeaders['content-length'];
    const size = typeof sizeHeaderValue === 'number' ? sizeHeaderValue : undefined;
    return {
      Bucket: destConfig.Bucket,
      Key: destConfig.Object,
      LastModified: copyRes.lastModified,
      MetaData: (0, _helper.extractMetadata)(resHeaders),
      VersionId: (0, _helper.getVersionId)(resHeaders),
      SourceVersionId: (0, _helper.getSourceVersionId)(resHeaders),
      Etag: (0, _helper.sanitizeETag)(resHeaders.etag),
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
    const body = await (0, _response.readAsString)(res);
    const partRes = (0, xmlParsers.uploadPartParser)(body);
    return {
      etag: (0, _helper.sanitizeETag)(partRes.ETag),
      key: objectName,
      part: partNumber
    };
  }
  async composeObject(destObjConfig, sourceObjList) {
    const sourceFilesLength = sourceObjList.length;
    if (!Array.isArray(sourceObjList)) {
      throw new errors.InvalidArgumentError('sourceConfig should an array of CopySourceOptions ');
    }
    if (!(destObjConfig instanceof _helpers.CopyDestinationOptions)) {
      throw new errors.InvalidArgumentError('destConfig should of type CopyDestinationOptions ');
    }
    if (sourceFilesLength < 1 || sourceFilesLength > _helper.PART_CONSTRAINTS.MAX_PARTS_COUNT) {
      throw new errors.InvalidArgumentError(`"There must be as least one and up to ${_helper.PART_CONSTRAINTS.MAX_PARTS_COUNT} source objects.`);
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
      if (!_lodash.isEmpty(srcConfig.VersionID)) {
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
      if (srcCopySize < _helper.PART_CONSTRAINTS.ABS_MIN_PART_SIZE && index < sourceFilesLength - 1) {
        throw new errors.InvalidArgumentError(`CopySrcOptions ${index} is too small (${srcCopySize}) and it is not the last part.`);
      }

      // Is data to copy too large?
      totalSize += srcCopySize;
      if (totalSize > _helper.PART_CONSTRAINTS.MAX_MULTIPART_PUT_OBJECT_SIZE) {
        throw new errors.InvalidArgumentError(`Cannot compose an object of size ${totalSize} (> 5TiB)`);
      }

      // record source size
      srcObjectSizes[index] = srcCopySize;

      // calculate parts needed for current source
      totalParts += (0, _helper.partsRequired)(srcCopySize);
      // Do we need more parts than we are allowed?
      if (totalParts > _helper.PART_CONSTRAINTS.MAX_PARTS_COUNT) {
        throw new errors.InvalidArgumentError(`Your proposed compose object requires more than ${_helper.PART_CONSTRAINTS.MAX_PARTS_COUNT} parts`);
      }
      return resItemStat;
    });
    if (totalParts === 1 && totalSize <= _helper.PART_CONSTRAINTS.MAX_PART_SIZE || totalSize === 0) {
      return await this.copyObject(sourceObjList[0], destObjConfig); // use copyObjectV2
    }

    // preserve etag to avoid modification of object while copying.
    for (let i = 0; i < sourceFilesLength; i++) {
      ;
      sourceObjList[i].MatchETag = validatedStats[i].etag;
    }
    const splitPartSizeList = validatedStats.map((resItemStat, idx) => {
      return (0, _helper.calculateEvenSplits)(srcObjectSizes[idx], sourceObjList[idx]);
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
      expires = _helpers.PRESIGN_EXPIRY_DAYS_MAX;
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
      return (0, _signing.presignSignatureV4)(reqOptions, this.accessKey, this.secretKey, this.sessionToken, region, requestDate, expires);
    } catch (err) {
      if (err instanceof errors.InvalidBucketNameError) {
        throw new errors.InvalidArgumentError(`Unable to get bucket region for ${bucketName}.`);
      }
      throw err;
    }
  }
  async presignedGetObject(bucketName, objectName, expires, respHeaders, requestDate) {
    if (!(0, _helper.isValidBucketName)(bucketName)) {
      throw new errors.InvalidBucketNameError('Invalid bucket name: ' + bucketName);
    }
    if (!(0, _helper.isValidObjectName)(objectName)) {
      throw new errors.InvalidObjectNameError(`Invalid object name: ${objectName}`);
    }
    const validRespHeaders = ['response-content-type', 'response-content-language', 'response-expires', 'response-cache-control', 'response-content-disposition', 'response-content-encoding'];
    validRespHeaders.forEach(header => {
      // @ts-ignore
      if (respHeaders !== undefined && respHeaders[header] !== undefined && !(0, _helper.isString)(respHeaders[header])) {
        throw new TypeError(`response header ${header} should be of type "string"`);
      }
    });
    return this.presignedUrl('GET', bucketName, objectName, expires, respHeaders, requestDate);
  }
  async presignedPutObject(bucketName, objectName, expires) {
    if (!(0, _helper.isValidBucketName)(bucketName)) {
      throw new errors.InvalidBucketNameError(`Invalid bucket name: ${bucketName}`);
    }
    if (!(0, _helper.isValidObjectName)(objectName)) {
      throw new errors.InvalidObjectNameError(`Invalid object name: ${objectName}`);
    }
    return this.presignedUrl('PUT', bucketName, objectName, expires);
  }
  newPostPolicy() {
    return new _postPolicy.PostPolicy();
  }
  async presignedPostPolicy(postPolicy) {
    if (this.anonymous) {
      throw new errors.AnonymousRequestError('Presigned POST policy cannot be generated for anonymous requests');
    }
    if (!(0, _helper.isObject)(postPolicy)) {
      throw new TypeError('postPolicy should be of type "object"');
    }
    const bucketName = postPolicy.formData.bucket;
    try {
      const region = await this.getBucketRegionAsync(bucketName);
      const date = new Date();
      const dateStr = (0, _helper.makeDateLong)(date);
      await this.checkAndRefreshCreds();
      if (!postPolicy.policy.expiration) {
        // 'expiration' is mandatory field for S3.
        // Set default expiration date of 7 days.
        const expires = new Date();
        expires.setSeconds(_helpers.PRESIGN_EXPIRY_DAYS_MAX);
        postPolicy.setExpires(expires);
      }
      postPolicy.policy.conditions.push(['eq', '$x-amz-date', dateStr]);
      postPolicy.formData['x-amz-date'] = dateStr;
      postPolicy.policy.conditions.push(['eq', '$x-amz-algorithm', 'AWS4-HMAC-SHA256']);
      postPolicy.formData['x-amz-algorithm'] = 'AWS4-HMAC-SHA256';
      postPolicy.policy.conditions.push(['eq', '$x-amz-credential', this.accessKey + '/' + (0, _helper.getScope)(region, date)]);
      postPolicy.formData['x-amz-credential'] = this.accessKey + '/' + (0, _helper.getScope)(region, date);
      if (this.sessionToken) {
        postPolicy.policy.conditions.push(['eq', '$x-amz-security-token', this.sessionToken]);
        postPolicy.formData['x-amz-security-token'] = this.sessionToken;
      }
      const policyBase64 = Buffer.from(JSON.stringify(postPolicy.policy)).toString('base64');
      postPolicy.formData.policy = policyBase64;
      postPolicy.formData['x-amz-signature'] = (0, _signing.postPresignSignatureV4)(region, date, this.secretKey, policyBase64);
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
    if (!(0, _helper.isValidBucketName)(bucketName)) {
      throw new errors.InvalidBucketNameError('Invalid bucket name: ' + bucketName);
    }
    if (!(0, _helper.isString)(prefix)) {
      throw new TypeError('prefix should be of type "string"');
    }
    if (marker && !(0, _helper.isString)(marker)) {
      throw new TypeError('marker should be of type "string"');
    }
    if (listQueryOpts && !(0, _helper.isObject)(listQueryOpts)) {
      throw new TypeError('listQueryOpts should be of type "object"');
    }
    let {
      Delimiter,
      MaxKeys,
      IncludeVersion,
      versionIdMarker,
      keyMarker
    } = listQueryOpts;
    if (!(0, _helper.isString)(Delimiter)) {
      throw new TypeError('Delimiter should be of type "string"');
    }
    if (!(0, _helper.isNumber)(MaxKeys)) {
      throw new TypeError('MaxKeys should be of type "number"');
    }
    const queries = [];
    // escape every value in query string, except maxKeys
    queries.push(`prefix=${(0, _helper.uriEscape)(prefix)}`);
    queries.push(`delimiter=${(0, _helper.uriEscape)(Delimiter)}`);
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
      marker = (0, _helper.uriEscape)(marker);
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
    const body = await (0, _response.readAsString)(res);
    const listQryList = (0, xmlParsers.parseListObjects)(body);
    return listQryList;
  }
  listObjects(bucketName, prefix, recursive, listOpts) {
    if (prefix === undefined) {
      prefix = '';
    }
    if (recursive === undefined) {
      recursive = false;
    }
    if (!(0, _helper.isValidBucketName)(bucketName)) {
      throw new errors.InvalidBucketNameError('Invalid bucket name: ' + bucketName);
    }
    if (!(0, _helper.isValidPrefix)(prefix)) {
      throw new errors.InvalidPrefixError(`Invalid prefix : ${prefix}`);
    }
    if (!(0, _helper.isString)(prefix)) {
      throw new TypeError('prefix should be of type "string"');
    }
    if (!(0, _helper.isBoolean)(recursive)) {
      throw new TypeError('recursive should be of type "boolean"');
    }
    if (listOpts && !(0, _helper.isObject)(listOpts)) {
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
exports.TypedClient = TypedClient;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJjcnlwdG8iLCJfaW50ZXJvcFJlcXVpcmVXaWxkY2FyZCIsInJlcXVpcmUiLCJmcyIsImh0dHAiLCJodHRwcyIsInBhdGgiLCJzdHJlYW0iLCJhc3luYyIsIl9ibG9ja1N0cmVhbSIsIl9icm93c2VyT3JOb2RlIiwiX2xvZGFzaCIsInFzIiwiX3htbDJqcyIsIl9DcmVkZW50aWFsUHJvdmlkZXIiLCJlcnJvcnMiLCJfaGVscGVycyIsIl9zaWduaW5nIiwiX2FzeW5jMiIsIl9jb3B5Q29uZGl0aW9ucyIsIl9leHRlbnNpb25zIiwiX2hlbHBlciIsIl9qb2luSG9zdFBvcnQiLCJfcG9zdFBvbGljeSIsIl9yZXF1ZXN0IiwiX3Jlc3BvbnNlIiwiX3MzRW5kcG9pbnRzIiwieG1sUGFyc2VycyIsIl9nZXRSZXF1aXJlV2lsZGNhcmRDYWNoZSIsIm5vZGVJbnRlcm9wIiwiV2Vha01hcCIsImNhY2hlQmFiZWxJbnRlcm9wIiwiY2FjaGVOb2RlSW50ZXJvcCIsIm9iaiIsIl9fZXNNb2R1bGUiLCJkZWZhdWx0IiwiY2FjaGUiLCJoYXMiLCJnZXQiLCJuZXdPYmoiLCJoYXNQcm9wZXJ0eURlc2NyaXB0b3IiLCJPYmplY3QiLCJkZWZpbmVQcm9wZXJ0eSIsImdldE93blByb3BlcnR5RGVzY3JpcHRvciIsImtleSIsInByb3RvdHlwZSIsImhhc093blByb3BlcnR5IiwiY2FsbCIsImRlc2MiLCJzZXQiLCJ4bWwiLCJ4bWwyanMiLCJCdWlsZGVyIiwicmVuZGVyT3B0cyIsInByZXR0eSIsImhlYWRsZXNzIiwiUGFja2FnZSIsInZlcnNpb24iLCJyZXF1ZXN0T3B0aW9uUHJvcGVydGllcyIsIlR5cGVkQ2xpZW50IiwicGFydFNpemUiLCJtYXhpbXVtUGFydFNpemUiLCJtYXhPYmplY3RTaXplIiwiY29uc3RydWN0b3IiLCJwYXJhbXMiLCJzZWN1cmUiLCJ1bmRlZmluZWQiLCJFcnJvciIsInVzZVNTTCIsInBvcnQiLCJpc1ZhbGlkRW5kcG9pbnQiLCJlbmRQb2ludCIsIkludmFsaWRFbmRwb2ludEVycm9yIiwiaXNWYWxpZFBvcnQiLCJJbnZhbGlkQXJndW1lbnRFcnJvciIsImlzQm9vbGVhbiIsInJlZ2lvbiIsImlzU3RyaW5nIiwiaG9zdCIsInRvTG93ZXJDYXNlIiwicHJvdG9jb2wiLCJ0cmFuc3BvcnQiLCJ0cmFuc3BvcnRBZ2VudCIsImdsb2JhbEFnZW50IiwiaXNPYmplY3QiLCJsaWJyYXJ5Q29tbWVudHMiLCJwcm9jZXNzIiwicGxhdGZvcm0iLCJhcmNoIiwibGlicmFyeUFnZW50IiwidXNlckFnZW50IiwicGF0aFN0eWxlIiwiYWNjZXNzS2V5Iiwic2VjcmV0S2V5Iiwic2Vzc2lvblRva2VuIiwiYW5vbnltb3VzIiwiY3JlZGVudGlhbHNQcm92aWRlciIsInJlZ2lvbk1hcCIsIm92ZXJSaWRlUGFydFNpemUiLCJlbmFibGVTSEEyNTYiLCJzM0FjY2VsZXJhdGVFbmRwb2ludCIsInJlcU9wdGlvbnMiLCJjbGllbnRFeHRlbnNpb25zIiwiRXh0ZW5zaW9ucyIsImV4dGVuc2lvbnMiLCJzZXRTM1RyYW5zZmVyQWNjZWxlcmF0ZSIsInNldFJlcXVlc3RPcHRpb25zIiwib3B0aW9ucyIsIlR5cGVFcnJvciIsIl8iLCJwaWNrIiwiZ2V0QWNjZWxlcmF0ZUVuZFBvaW50SWZTZXQiLCJidWNrZXROYW1lIiwib2JqZWN0TmFtZSIsImlzRW1wdHkiLCJpbmNsdWRlcyIsInNldEFwcEluZm8iLCJhcHBOYW1lIiwiYXBwVmVyc2lvbiIsInRyaW0iLCJnZXRSZXF1ZXN0T3B0aW9ucyIsIm9wdHMiLCJtZXRob2QiLCJoZWFkZXJzIiwicXVlcnkiLCJhZ2VudCIsInZpcnR1YWxIb3N0U3R5bGUiLCJpc1ZpcnR1YWxIb3N0U3R5bGUiLCJ1cmlSZXNvdXJjZUVzY2FwZSIsImlzQW1hem9uRW5kcG9pbnQiLCJhY2NlbGVyYXRlRW5kUG9pbnQiLCJnZXRTM0VuZHBvaW50Iiwiam9pbkhvc3RQb3J0IiwiayIsInYiLCJlbnRyaWVzIiwiYXNzaWduIiwibWFwVmFsdWVzIiwicGlja0J5IiwiaXNEZWZpbmVkIiwidG9TdHJpbmciLCJzZXRDcmVkZW50aWFsc1Byb3ZpZGVyIiwiQ3JlZGVudGlhbFByb3ZpZGVyIiwiY2hlY2tBbmRSZWZyZXNoQ3JlZHMiLCJjcmVkZW50aWFsc0NvbmYiLCJnZXRDcmVkZW50aWFscyIsImdldEFjY2Vzc0tleSIsImdldFNlY3JldEtleSIsImdldFNlc3Npb25Ub2tlbiIsImUiLCJjYXVzZSIsImxvZ0hUVFAiLCJyZXNwb25zZSIsImVyciIsImxvZ1N0cmVhbSIsImlzUmVhZGFibGVTdHJlYW0iLCJsb2dIZWFkZXJzIiwiZm9yRWFjaCIsInJlZGFjdG9yIiwiUmVnRXhwIiwicmVwbGFjZSIsIndyaXRlIiwic3RhdHVzQ29kZSIsImVyckpTT04iLCJKU09OIiwic3RyaW5naWZ5IiwidHJhY2VPbiIsInN0ZG91dCIsInRyYWNlT2ZmIiwibWFrZVJlcXVlc3RBc3luYyIsInBheWxvYWQiLCJleHBlY3RlZENvZGVzIiwiaXNOdW1iZXIiLCJsZW5ndGgiLCJzaGEyNTZzdW0iLCJ0b1NoYTI1NiIsIm1ha2VSZXF1ZXN0U3RyZWFtQXN5bmMiLCJtYWtlUmVxdWVzdEFzeW5jT21pdCIsInN0YXR1c0NvZGVzIiwicmVzIiwiZHJhaW5SZXNwb25zZSIsImJvZHkiLCJCdWZmZXIiLCJpc0J1ZmZlciIsImdldEJ1Y2tldFJlZ2lvbkFzeW5jIiwiZGF0ZSIsIkRhdGUiLCJtYWtlRGF0ZUxvbmciLCJhdXRob3JpemF0aW9uIiwic2lnblY0IiwicmVxdWVzdFdpdGhSZXRyeSIsInBhcnNlUmVzcG9uc2VFcnJvciIsImlzVmFsaWRCdWNrZXROYW1lIiwiSW52YWxpZEJ1Y2tldE5hbWVFcnJvciIsImNhY2hlZCIsImV4dHJhY3RSZWdpb25Bc3luYyIsInJlYWRBc1N0cmluZyIsInBhcnNlQnVja2V0UmVnaW9uIiwiREVGQVVMVF9SRUdJT04iLCJpc0Jyb3dzZXIiLCJTM0Vycm9yIiwiZXJyQ29kZSIsImNvZGUiLCJlcnJSZWdpb24iLCJuYW1lIiwiUmVnaW9uIiwibWFrZVJlcXVlc3QiLCJyZXR1cm5SZXNwb25zZSIsImNiIiwicHJvbSIsInRoZW4iLCJyZXN1bHQiLCJtYWtlUmVxdWVzdFN0cmVhbSIsImV4ZWN1dG9yIiwiZ2V0QnVja2V0UmVnaW9uIiwibWFrZUJ1Y2tldCIsIm1ha2VPcHRzIiwiYnVpbGRPYmplY3QiLCJDcmVhdGVCdWNrZXRDb25maWd1cmF0aW9uIiwiJCIsInhtbG5zIiwiTG9jYXRpb25Db25zdHJhaW50IiwiT2JqZWN0TG9ja2luZyIsImZpbmFsUmVnaW9uIiwicmVxdWVzdE9wdCIsImJ1Y2tldEV4aXN0cyIsInJlbW92ZUJ1Y2tldCIsImdldE9iamVjdCIsImdldE9wdHMiLCJpc1ZhbGlkT2JqZWN0TmFtZSIsIkludmFsaWRPYmplY3ROYW1lRXJyb3IiLCJnZXRQYXJ0aWFsT2JqZWN0Iiwib2Zmc2V0IiwicmFuZ2UiLCJzc2VIZWFkZXJzIiwiU1NFQ3VzdG9tZXJBbGdvcml0aG0iLCJTU0VDdXN0b21lcktleSIsIlNTRUN1c3RvbWVyS2V5TUQ1IiwicHJlcGVuZFhBTVpNZXRhIiwiZXhwZWN0ZWRTdGF0dXNDb2RlcyIsInB1c2giLCJmR2V0T2JqZWN0IiwiZmlsZVBhdGgiLCJkb3dubG9hZFRvVG1wRmlsZSIsInBhcnRGaWxlU3RyZWFtIiwib2JqU3RhdCIsInN0YXRPYmplY3QiLCJlbmNvZGVkRXRhZyIsImZyb20iLCJldGFnIiwicGFydEZpbGUiLCJmc3AiLCJta2RpciIsImRpcm5hbWUiLCJyZWN1cnNpdmUiLCJzdGF0cyIsInN0YXQiLCJzaXplIiwiY3JlYXRlV3JpdGVTdHJlYW0iLCJmbGFncyIsImRvd25sb2FkU3RyZWFtIiwic3RyZWFtUHJvbWlzZSIsInBpcGVsaW5lIiwicmVuYW1lIiwic3RhdE9wdHMiLCJzdGF0T3B0RGVmIiwicGFyc2VJbnQiLCJtZXRhRGF0YSIsImV4dHJhY3RNZXRhZGF0YSIsImxhc3RNb2RpZmllZCIsInZlcnNpb25JZCIsImdldFZlcnNpb25JZCIsInNhbml0aXplRVRhZyIsInJlbW92ZU9iamVjdCIsInJlbW92ZU9wdHMiLCJnb3Zlcm5hbmNlQnlwYXNzIiwiZm9yY2VEZWxldGUiLCJxdWVyeVBhcmFtcyIsImxpc3RJbmNvbXBsZXRlVXBsb2FkcyIsImJ1Y2tldCIsInByZWZpeCIsImlzVmFsaWRQcmVmaXgiLCJJbnZhbGlkUHJlZml4RXJyb3IiLCJkZWxpbWl0ZXIiLCJrZXlNYXJrZXIiLCJ1cGxvYWRJZE1hcmtlciIsInVwbG9hZHMiLCJlbmRlZCIsInJlYWRTdHJlYW0iLCJSZWFkYWJsZSIsIm9iamVjdE1vZGUiLCJfcmVhZCIsInNoaWZ0IiwibGlzdEluY29tcGxldGVVcGxvYWRzUXVlcnkiLCJwcmVmaXhlcyIsImVhY2hTZXJpZXMiLCJ1cGxvYWQiLCJsaXN0UGFydHMiLCJ1cGxvYWRJZCIsInBhcnRzIiwicmVkdWNlIiwiYWNjIiwiaXRlbSIsImVtaXQiLCJpc1RydW5jYXRlZCIsIm5leHRLZXlNYXJrZXIiLCJuZXh0VXBsb2FkSWRNYXJrZXIiLCJxdWVyaWVzIiwidXJpRXNjYXBlIiwibWF4VXBsb2FkcyIsInNvcnQiLCJ1bnNoaWZ0Iiwiam9pbiIsInBhcnNlTGlzdE11bHRpcGFydCIsImluaXRpYXRlTmV3TXVsdGlwYXJ0VXBsb2FkIiwicmVhZEFzQnVmZmVyIiwicGFyc2VJbml0aWF0ZU11bHRpcGFydCIsImFib3J0TXVsdGlwYXJ0VXBsb2FkIiwicmVxdWVzdE9wdGlvbnMiLCJmaW5kVXBsb2FkSWQiLCJfbGF0ZXN0VXBsb2FkIiwibGF0ZXN0VXBsb2FkIiwiaW5pdGlhdGVkIiwiZ2V0VGltZSIsImNvbXBsZXRlTXVsdGlwYXJ0VXBsb2FkIiwiZXRhZ3MiLCJidWlsZGVyIiwiQ29tcGxldGVNdWx0aXBhcnRVcGxvYWQiLCJQYXJ0IiwibWFwIiwiUGFydE51bWJlciIsInBhcnQiLCJFVGFnIiwicGFyc2VDb21wbGV0ZU11bHRpcGFydCIsImVyck1lc3NhZ2UiLCJtYXJrZXIiLCJsaXN0UGFydHNRdWVyeSIsInBhcnNlTGlzdFBhcnRzIiwibGlzdEJ1Y2tldHMiLCJyZWdpb25Db25mIiwiaHR0cFJlcyIsInhtbFJlc3VsdCIsInBhcnNlTGlzdEJ1Y2tldCIsImNhbGN1bGF0ZVBhcnRTaXplIiwiZlB1dE9iamVjdCIsImluc2VydENvbnRlbnRUeXBlIiwicHV0T2JqZWN0IiwiY3JlYXRlUmVhZFN0cmVhbSIsInJlYWRhYmxlU3RyZWFtIiwic3RhdFNpemUiLCJnZXRDb250ZW50TGVuZ3RoIiwidXBsb2FkQnVmZmVyIiwiYnVmIiwidXBsb2FkU3RyZWFtIiwibWQ1c3VtIiwiaGFzaEJpbmFyeSIsIm9sZFBhcnRzIiwiZVRhZ3MiLCJwcmV2aW91c1VwbG9hZElkIiwib2xkVGFncyIsImNodW5raWVyIiwiQmxvY2tTdHJlYW0yIiwiemVyb1BhZGRpbmciLCJvIiwiUHJvbWlzZSIsImFsbCIsInJlc29sdmUiLCJyZWplY3QiLCJwaXBlIiwib24iLCJwYXJ0TnVtYmVyIiwiY2h1bmsiLCJtZDUiLCJjcmVhdGVIYXNoIiwidXBkYXRlIiwiZGlnZXN0Iiwib2xkUGFydCIsInJlbW92ZUJ1Y2tldFJlcGxpY2F0aW9uIiwic2V0QnVja2V0UmVwbGljYXRpb24iLCJyZXBsaWNhdGlvbkNvbmZpZyIsInJvbGUiLCJydWxlcyIsInJlcGxpY2F0aW9uUGFyYW1zQ29uZmlnIiwiUmVwbGljYXRpb25Db25maWd1cmF0aW9uIiwiUm9sZSIsIlJ1bGUiLCJ0b01kNSIsImdldEJ1Y2tldFJlcGxpY2F0aW9uIiwicGFyc2VSZXBsaWNhdGlvbkNvbmZpZyIsImdldE9iamVjdExlZ2FsSG9sZCIsImtleXMiLCJzdHJSZXMiLCJwYXJzZU9iamVjdExlZ2FsSG9sZENvbmZpZyIsInNldE9iamVjdExlZ2FsSG9sZCIsInNldE9wdHMiLCJzdGF0dXMiLCJMRUdBTF9IT0xEX1NUQVRVUyIsIkVOQUJMRUQiLCJESVNBQkxFRCIsImNvbmZpZyIsIlN0YXR1cyIsInJvb3ROYW1lIiwiZ2V0QnVja2V0VGFnZ2luZyIsInBhcnNlVGFnZ2luZyIsImdldE9iamVjdFRhZ2dpbmciLCJzZXRCdWNrZXRQb2xpY3kiLCJwb2xpY3kiLCJJbnZhbGlkQnVja2V0UG9saWN5RXJyb3IiLCJnZXRCdWNrZXRQb2xpY3kiLCJwdXRPYmplY3RSZXRlbnRpb24iLCJyZXRlbnRpb25PcHRzIiwibW9kZSIsIlJFVEVOVElPTl9NT0RFUyIsIkNPTVBMSUFOQ0UiLCJHT1ZFUk5BTkNFIiwicmV0YWluVW50aWxEYXRlIiwiTW9kZSIsIlJldGFpblVudGlsRGF0ZSIsImdldE9iamVjdExvY2tDb25maWciLCJwYXJzZU9iamVjdExvY2tDb25maWciLCJzZXRPYmplY3RMb2NrQ29uZmlnIiwibG9ja0NvbmZpZ09wdHMiLCJyZXRlbnRpb25Nb2RlcyIsInZhbGlkVW5pdHMiLCJSRVRFTlRJT05fVkFMSURJVFlfVU5JVFMiLCJEQVlTIiwiWUVBUlMiLCJ1bml0IiwidmFsaWRpdHkiLCJPYmplY3RMb2NrRW5hYmxlZCIsImNvbmZpZ0tleXMiLCJpc0FsbEtleXNTZXQiLCJldmVyeSIsImxjayIsIkRlZmF1bHRSZXRlbnRpb24iLCJEYXlzIiwiWWVhcnMiLCJnZXRCdWNrZXRWZXJzaW9uaW5nIiwicGFyc2VCdWNrZXRWZXJzaW9uaW5nQ29uZmlnIiwic2V0QnVja2V0VmVyc2lvbmluZyIsInZlcnNpb25Db25maWciLCJzZXRUYWdnaW5nIiwidGFnZ2luZ1BhcmFtcyIsInRhZ3MiLCJwdXRPcHRzIiwidGFnc0xpc3QiLCJ2YWx1ZSIsIktleSIsIlZhbHVlIiwidGFnZ2luZ0NvbmZpZyIsIlRhZ2dpbmciLCJUYWdTZXQiLCJUYWciLCJwYXlsb2FkQnVmIiwicmVtb3ZlVGFnZ2luZyIsInNldEJ1Y2tldFRhZ2dpbmciLCJpc1BsYWluT2JqZWN0IiwicmVtb3ZlQnVja2V0VGFnZ2luZyIsInNldE9iamVjdFRhZ2dpbmciLCJyZW1vdmVPYmplY3RUYWdnaW5nIiwic2VsZWN0T2JqZWN0Q29udGVudCIsInNlbGVjdE9wdHMiLCJleHByZXNzaW9uIiwiaW5wdXRTZXJpYWxpemF0aW9uIiwib3V0cHV0U2VyaWFsaXphdGlvbiIsIkV4cHJlc3Npb24iLCJFeHByZXNzaW9uVHlwZSIsImV4cHJlc3Npb25UeXBlIiwiSW5wdXRTZXJpYWxpemF0aW9uIiwiT3V0cHV0U2VyaWFsaXphdGlvbiIsInJlcXVlc3RQcm9ncmVzcyIsIlJlcXVlc3RQcm9ncmVzcyIsInNjYW5SYW5nZSIsIlNjYW5SYW5nZSIsInBhcnNlU2VsZWN0T2JqZWN0Q29udGVudFJlc3BvbnNlIiwiYXBwbHlCdWNrZXRMaWZlY3ljbGUiLCJwb2xpY3lDb25maWciLCJyZW1vdmVCdWNrZXRMaWZlY3ljbGUiLCJzZXRCdWNrZXRMaWZlY3ljbGUiLCJsaWZlQ3ljbGVDb25maWciLCJnZXRCdWNrZXRMaWZlY3ljbGUiLCJwYXJzZUxpZmVjeWNsZUNvbmZpZyIsInNldEJ1Y2tldEVuY3J5cHRpb24iLCJlbmNyeXB0aW9uQ29uZmlnIiwiZW5jcnlwdGlvbk9iaiIsIkFwcGx5U2VydmVyU2lkZUVuY3J5cHRpb25CeURlZmF1bHQiLCJTU0VBbGdvcml0aG0iLCJnZXRCdWNrZXRFbmNyeXB0aW9uIiwicGFyc2VCdWNrZXRFbmNyeXB0aW9uQ29uZmlnIiwicmVtb3ZlQnVja2V0RW5jcnlwdGlvbiIsImdldE9iamVjdFJldGVudGlvbiIsInBhcnNlT2JqZWN0UmV0ZW50aW9uQ29uZmlnIiwicmVtb3ZlT2JqZWN0cyIsIm9iamVjdHNMaXN0IiwiQXJyYXkiLCJpc0FycmF5IiwicnVuRGVsZXRlT2JqZWN0cyIsImJhdGNoIiwiZGVsT2JqZWN0cyIsIlZlcnNpb25JZCIsInJlbU9iamVjdHMiLCJEZWxldGUiLCJRdWlldCIsInJlbW92ZU9iamVjdHNQYXJzZXIiLCJtYXhFbnRyaWVzIiwiYmF0Y2hlcyIsImkiLCJzbGljZSIsImJhdGNoUmVzdWx0cyIsImZsYXQiLCJyZW1vdmVJbmNvbXBsZXRlVXBsb2FkIiwiSXNWYWxpZEJ1Y2tldE5hbWVFcnJvciIsInJlbW92ZVVwbG9hZElkIiwiY29weU9iamVjdFYxIiwidGFyZ2V0QnVja2V0TmFtZSIsInRhcmdldE9iamVjdE5hbWUiLCJzb3VyY2VCdWNrZXROYW1lQW5kT2JqZWN0TmFtZSIsImNvbmRpdGlvbnMiLCJDb3B5Q29uZGl0aW9ucyIsIm1vZGlmaWVkIiwidW5tb2RpZmllZCIsIm1hdGNoRVRhZyIsIm1hdGNoRVRhZ0V4Y2VwdCIsInBhcnNlQ29weU9iamVjdCIsImNvcHlPYmplY3RWMiIsInNvdXJjZUNvbmZpZyIsImRlc3RDb25maWciLCJDb3B5U291cmNlT3B0aW9ucyIsIkNvcHlEZXN0aW5hdGlvbk9wdGlvbnMiLCJ2YWxpZGF0ZSIsImdldEhlYWRlcnMiLCJCdWNrZXQiLCJjb3B5UmVzIiwicmVzSGVhZGVycyIsInNpemVIZWFkZXJWYWx1ZSIsIkxhc3RNb2RpZmllZCIsIk1ldGFEYXRhIiwiU291cmNlVmVyc2lvbklkIiwiZ2V0U291cmNlVmVyc2lvbklkIiwiRXRhZyIsIlNpemUiLCJjb3B5T2JqZWN0IiwiYWxsQXJncyIsInNvdXJjZSIsImRlc3QiLCJ1cGxvYWRQYXJ0IiwicGFydENvbmZpZyIsInVwbG9hZElEIiwicGFydFJlcyIsInVwbG9hZFBhcnRQYXJzZXIiLCJjb21wb3NlT2JqZWN0IiwiZGVzdE9iakNvbmZpZyIsInNvdXJjZU9iakxpc3QiLCJzb3VyY2VGaWxlc0xlbmd0aCIsIlBBUlRfQ09OU1RSQUlOVFMiLCJNQVhfUEFSVFNfQ09VTlQiLCJzT2JqIiwiZ2V0U3RhdE9wdGlvbnMiLCJzcmNDb25maWciLCJWZXJzaW9uSUQiLCJzcmNPYmplY3RTaXplcyIsInRvdGFsU2l6ZSIsInRvdGFsUGFydHMiLCJzb3VyY2VPYmpTdGF0cyIsInNyY0l0ZW0iLCJzcmNPYmplY3RJbmZvcyIsInZhbGlkYXRlZFN0YXRzIiwicmVzSXRlbVN0YXQiLCJpbmRleCIsInNyY0NvcHlTaXplIiwiTWF0Y2hSYW5nZSIsInNyY1N0YXJ0IiwiU3RhcnQiLCJzcmNFbmQiLCJFbmQiLCJBQlNfTUlOX1BBUlRfU0laRSIsIk1BWF9NVUxUSVBBUlRfUFVUX09CSkVDVF9TSVpFIiwicGFydHNSZXF1aXJlZCIsIk1BWF9QQVJUX1NJWkUiLCJNYXRjaEVUYWciLCJzcGxpdFBhcnRTaXplTGlzdCIsImlkeCIsImNhbGN1bGF0ZUV2ZW5TcGxpdHMiLCJnZXRVcGxvYWRQYXJ0Q29uZmlnTGlzdCIsInVwbG9hZFBhcnRDb25maWdMaXN0Iiwic3BsaXRTaXplIiwic3BsaXRJbmRleCIsInN0YXJ0SW5kZXgiLCJzdGFydElkeCIsImVuZEluZGV4IiwiZW5kSWR4Iiwib2JqSW5mbyIsIm9iakNvbmZpZyIsInBhcnRJbmRleCIsInRvdGFsVXBsb2FkcyIsInNwbGl0U3RhcnQiLCJ1cGxkQ3RySWR4Iiwic3BsaXRFbmQiLCJzb3VyY2VPYmoiLCJ1cGxvYWRQYXJ0Q29uZmlnIiwidXBsb2FkQWxsUGFydHMiLCJ1cGxvYWRMaXN0IiwicGFydFVwbG9hZHMiLCJwZXJmb3JtVXBsb2FkUGFydHMiLCJwYXJ0c1JlcyIsInBhcnRDb3B5IiwibmV3VXBsb2FkSGVhZGVycyIsInBhcnRzRG9uZSIsInByZXNpZ25lZFVybCIsImV4cGlyZXMiLCJyZXFQYXJhbXMiLCJyZXF1ZXN0RGF0ZSIsIl9yZXF1ZXN0RGF0ZSIsIkFub255bW91c1JlcXVlc3RFcnJvciIsIlBSRVNJR05fRVhQSVJZX0RBWVNfTUFYIiwiaXNOYU4iLCJwcmVzaWduU2lnbmF0dXJlVjQiLCJwcmVzaWduZWRHZXRPYmplY3QiLCJyZXNwSGVhZGVycyIsInZhbGlkUmVzcEhlYWRlcnMiLCJoZWFkZXIiLCJwcmVzaWduZWRQdXRPYmplY3QiLCJuZXdQb3N0UG9saWN5IiwiUG9zdFBvbGljeSIsInByZXNpZ25lZFBvc3RQb2xpY3kiLCJwb3N0UG9saWN5IiwiZm9ybURhdGEiLCJkYXRlU3RyIiwiZXhwaXJhdGlvbiIsInNldFNlY29uZHMiLCJzZXRFeHBpcmVzIiwiZ2V0U2NvcGUiLCJwb2xpY3lCYXNlNjQiLCJwb3N0UHJlc2lnblNpZ25hdHVyZVY0IiwicG9ydFN0ciIsInVybFN0ciIsInBvc3RVUkwiLCJsaXN0T2JqZWN0c1F1ZXJ5IiwibGlzdFF1ZXJ5T3B0cyIsIkRlbGltaXRlciIsIk1heEtleXMiLCJJbmNsdWRlVmVyc2lvbiIsInZlcnNpb25JZE1hcmtlciIsImxpc3RRcnlMaXN0IiwicGFyc2VMaXN0T2JqZWN0cyIsImxpc3RPYmplY3RzIiwibGlzdE9wdHMiLCJvYmplY3RzIiwibmV4dE1hcmtlciIsImV4cG9ydHMiXSwic291cmNlcyI6WyJjbGllbnQudHMiXSwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0ICogYXMgY3J5cHRvIGZyb20gJ25vZGU6Y3J5cHRvJ1xuaW1wb3J0ICogYXMgZnMgZnJvbSAnbm9kZTpmcydcbmltcG9ydCB0eXBlIHsgSW5jb21pbmdIdHRwSGVhZGVycyB9IGZyb20gJ25vZGU6aHR0cCdcbmltcG9ydCAqIGFzIGh0dHAgZnJvbSAnbm9kZTpodHRwJ1xuaW1wb3J0ICogYXMgaHR0cHMgZnJvbSAnbm9kZTpodHRwcydcbmltcG9ydCAqIGFzIHBhdGggZnJvbSAnbm9kZTpwYXRoJ1xuaW1wb3J0ICogYXMgc3RyZWFtIGZyb20gJ25vZGU6c3RyZWFtJ1xuXG5pbXBvcnQgKiBhcyBhc3luYyBmcm9tICdhc3luYydcbmltcG9ydCBCbG9ja1N0cmVhbTIgZnJvbSAnYmxvY2stc3RyZWFtMidcbmltcG9ydCB7IGlzQnJvd3NlciB9IGZyb20gJ2Jyb3dzZXItb3Itbm9kZSdcbmltcG9ydCBfIGZyb20gJ2xvZGFzaCdcbmltcG9ydCAqIGFzIHFzIGZyb20gJ3F1ZXJ5LXN0cmluZydcbmltcG9ydCB4bWwyanMgZnJvbSAneG1sMmpzJ1xuXG5pbXBvcnQgeyBDcmVkZW50aWFsUHJvdmlkZXIgfSBmcm9tICcuLi9DcmVkZW50aWFsUHJvdmlkZXIudHMnXG5pbXBvcnQgKiBhcyBlcnJvcnMgZnJvbSAnLi4vZXJyb3JzLnRzJ1xuaW1wb3J0IHR5cGUgeyBTZWxlY3RSZXN1bHRzIH0gZnJvbSAnLi4vaGVscGVycy50cydcbmltcG9ydCB7XG4gIENvcHlEZXN0aW5hdGlvbk9wdGlvbnMsXG4gIENvcHlTb3VyY2VPcHRpb25zLFxuICBERUZBVUxUX1JFR0lPTixcbiAgTEVHQUxfSE9MRF9TVEFUVVMsXG4gIFBSRVNJR05fRVhQSVJZX0RBWVNfTUFYLFxuICBSRVRFTlRJT05fTU9ERVMsXG4gIFJFVEVOVElPTl9WQUxJRElUWV9VTklUUyxcbn0gZnJvbSAnLi4vaGVscGVycy50cydcbmltcG9ydCB0eXBlIHsgUG9zdFBvbGljeVJlc3VsdCB9IGZyb20gJy4uL21pbmlvLnRzJ1xuaW1wb3J0IHsgcG9zdFByZXNpZ25TaWduYXR1cmVWNCwgcHJlc2lnblNpZ25hdHVyZVY0LCBzaWduVjQgfSBmcm9tICcuLi9zaWduaW5nLnRzJ1xuaW1wb3J0IHsgZnNwLCBzdHJlYW1Qcm9taXNlIH0gZnJvbSAnLi9hc3luYy50cydcbmltcG9ydCB7IENvcHlDb25kaXRpb25zIH0gZnJvbSAnLi9jb3B5LWNvbmRpdGlvbnMudHMnXG5pbXBvcnQgeyBFeHRlbnNpb25zIH0gZnJvbSAnLi9leHRlbnNpb25zLnRzJ1xuaW1wb3J0IHtcbiAgY2FsY3VsYXRlRXZlblNwbGl0cyxcbiAgZXh0cmFjdE1ldGFkYXRhLFxuICBnZXRDb250ZW50TGVuZ3RoLFxuICBnZXRTY29wZSxcbiAgZ2V0U291cmNlVmVyc2lvbklkLFxuICBnZXRWZXJzaW9uSWQsXG4gIGhhc2hCaW5hcnksXG4gIGluc2VydENvbnRlbnRUeXBlLFxuICBpc0FtYXpvbkVuZHBvaW50LFxuICBpc0Jvb2xlYW4sXG4gIGlzRGVmaW5lZCxcbiAgaXNFbXB0eSxcbiAgaXNOdW1iZXIsXG4gIGlzT2JqZWN0LFxuICBpc1BsYWluT2JqZWN0LFxuICBpc1JlYWRhYmxlU3RyZWFtLFxuICBpc1N0cmluZyxcbiAgaXNWYWxpZEJ1Y2tldE5hbWUsXG4gIGlzVmFsaWRFbmRwb2ludCxcbiAgaXNWYWxpZE9iamVjdE5hbWUsXG4gIGlzVmFsaWRQb3J0LFxuICBpc1ZhbGlkUHJlZml4LFxuICBpc1ZpcnR1YWxIb3N0U3R5bGUsXG4gIG1ha2VEYXRlTG9uZyxcbiAgUEFSVF9DT05TVFJBSU5UUyxcbiAgcGFydHNSZXF1aXJlZCxcbiAgcHJlcGVuZFhBTVpNZXRhLFxuICByZWFkYWJsZVN0cmVhbSxcbiAgc2FuaXRpemVFVGFnLFxuICB0b01kNSxcbiAgdG9TaGEyNTYsXG4gIHVyaUVzY2FwZSxcbiAgdXJpUmVzb3VyY2VFc2NhcGUsXG59IGZyb20gJy4vaGVscGVyLnRzJ1xuaW1wb3J0IHsgam9pbkhvc3RQb3J0IH0gZnJvbSAnLi9qb2luLWhvc3QtcG9ydC50cydcbmltcG9ydCB7IFBvc3RQb2xpY3kgfSBmcm9tICcuL3Bvc3QtcG9saWN5LnRzJ1xuaW1wb3J0IHsgcmVxdWVzdFdpdGhSZXRyeSB9IGZyb20gJy4vcmVxdWVzdC50cydcbmltcG9ydCB7IGRyYWluUmVzcG9uc2UsIHJlYWRBc0J1ZmZlciwgcmVhZEFzU3RyaW5nIH0gZnJvbSAnLi9yZXNwb25zZS50cydcbmltcG9ydCB0eXBlIHsgUmVnaW9uIH0gZnJvbSAnLi9zMy1lbmRwb2ludHMudHMnXG5pbXBvcnQgeyBnZXRTM0VuZHBvaW50IH0gZnJvbSAnLi9zMy1lbmRwb2ludHMudHMnXG5pbXBvcnQgdHlwZSB7XG4gIEJpbmFyeSxcbiAgQnVja2V0SXRlbUZyb21MaXN0LFxuICBCdWNrZXRJdGVtU3RhdCxcbiAgQnVja2V0U3RyZWFtLFxuICBCdWNrZXRWZXJzaW9uaW5nQ29uZmlndXJhdGlvbixcbiAgQ29weU9iamVjdFBhcmFtcyxcbiAgQ29weU9iamVjdFJlc3VsdCxcbiAgQ29weU9iamVjdFJlc3VsdFYyLFxuICBFbmNyeXB0aW9uQ29uZmlnLFxuICBHZXRPYmplY3RMZWdhbEhvbGRPcHRpb25zLFxuICBHZXRPYmplY3RPcHRzLFxuICBHZXRPYmplY3RSZXRlbnRpb25PcHRzLFxuICBJbmNvbXBsZXRlVXBsb2FkZWRCdWNrZXRJdGVtLFxuICBJUmVxdWVzdCxcbiAgSXRlbUJ1Y2tldE1ldGFkYXRhLFxuICBMaWZlY3ljbGVDb25maWcsXG4gIExpZmVDeWNsZUNvbmZpZ1BhcmFtLFxuICBMaXN0T2JqZWN0UXVlcnlPcHRzLFxuICBMaXN0T2JqZWN0UXVlcnlSZXMsXG4gIE9iamVjdEluZm8sXG4gIE9iamVjdExvY2tDb25maWdQYXJhbSxcbiAgT2JqZWN0TG9ja0luZm8sXG4gIE9iamVjdE1ldGFEYXRhLFxuICBPYmplY3RSZXRlbnRpb25JbmZvLFxuICBQcmVTaWduUmVxdWVzdFBhcmFtcyxcbiAgUHV0T2JqZWN0TGVnYWxIb2xkT3B0aW9ucyxcbiAgUHV0VGFnZ2luZ1BhcmFtcyxcbiAgUmVtb3ZlT2JqZWN0c1BhcmFtLFxuICBSZW1vdmVPYmplY3RzUmVxdWVzdEVudHJ5LFxuICBSZW1vdmVPYmplY3RzUmVzcG9uc2UsXG4gIFJlbW92ZVRhZ2dpbmdQYXJhbXMsXG4gIFJlcGxpY2F0aW9uQ29uZmlnLFxuICBSZXBsaWNhdGlvbkNvbmZpZ09wdHMsXG4gIFJlcXVlc3RIZWFkZXJzLFxuICBSZXNwb25zZUhlYWRlcixcbiAgUmVzdWx0Q2FsbGJhY2ssXG4gIFJldGVudGlvbixcbiAgU2VsZWN0T3B0aW9ucyxcbiAgU3RhdE9iamVjdE9wdHMsXG4gIFRhZyxcbiAgVGFnZ2luZ09wdHMsXG4gIFRhZ3MsXG4gIFRyYW5zcG9ydCxcbiAgVXBsb2FkZWRPYmplY3RJbmZvLFxuICBVcGxvYWRQYXJ0Q29uZmlnLFxufSBmcm9tICcuL3R5cGUudHMnXG5pbXBvcnQgdHlwZSB7IExpc3RNdWx0aXBhcnRSZXN1bHQsIFVwbG9hZGVkUGFydCB9IGZyb20gJy4veG1sLXBhcnNlci50cydcbmltcG9ydCB7XG4gIHBhcnNlQ29tcGxldGVNdWx0aXBhcnQsXG4gIHBhcnNlSW5pdGlhdGVNdWx0aXBhcnQsXG4gIHBhcnNlTGlzdE9iamVjdHMsXG4gIHBhcnNlT2JqZWN0TGVnYWxIb2xkQ29uZmlnLFxuICBwYXJzZVNlbGVjdE9iamVjdENvbnRlbnRSZXNwb25zZSxcbiAgdXBsb2FkUGFydFBhcnNlcixcbn0gZnJvbSAnLi94bWwtcGFyc2VyLnRzJ1xuaW1wb3J0ICogYXMgeG1sUGFyc2VycyBmcm9tICcuL3htbC1wYXJzZXIudHMnXG5cbmNvbnN0IHhtbCA9IG5ldyB4bWwyanMuQnVpbGRlcih7IHJlbmRlck9wdHM6IHsgcHJldHR5OiBmYWxzZSB9LCBoZWFkbGVzczogdHJ1ZSB9KVxuXG4vLyB3aWxsIGJlIHJlcGxhY2VkIGJ5IGJ1bmRsZXIuXG5jb25zdCBQYWNrYWdlID0geyB2ZXJzaW9uOiBwcm9jZXNzLmVudi5NSU5JT19KU19QQUNLQUdFX1ZFUlNJT04gfHwgJ2RldmVsb3BtZW50JyB9XG5cbmNvbnN0IHJlcXVlc3RPcHRpb25Qcm9wZXJ0aWVzID0gW1xuICAnYWdlbnQnLFxuICAnY2EnLFxuICAnY2VydCcsXG4gICdjaXBoZXJzJyxcbiAgJ2NsaWVudENlcnRFbmdpbmUnLFxuICAnY3JsJyxcbiAgJ2RocGFyYW0nLFxuICAnZWNkaEN1cnZlJyxcbiAgJ2ZhbWlseScsXG4gICdob25vckNpcGhlck9yZGVyJyxcbiAgJ2tleScsXG4gICdwYXNzcGhyYXNlJyxcbiAgJ3BmeCcsXG4gICdyZWplY3RVbmF1dGhvcml6ZWQnLFxuICAnc2VjdXJlT3B0aW9ucycsXG4gICdzZWN1cmVQcm90b2NvbCcsXG4gICdzZXJ2ZXJuYW1lJyxcbiAgJ3Nlc3Npb25JZENvbnRleHQnLFxuXSBhcyBjb25zdFxuXG5leHBvcnQgaW50ZXJmYWNlIENsaWVudE9wdGlvbnMge1xuICBlbmRQb2ludDogc3RyaW5nXG4gIGFjY2Vzc0tleT86IHN0cmluZ1xuICBzZWNyZXRLZXk/OiBzdHJpbmdcbiAgdXNlU1NMPzogYm9vbGVhblxuICBwb3J0PzogbnVtYmVyXG4gIHJlZ2lvbj86IFJlZ2lvblxuICB0cmFuc3BvcnQ/OiBUcmFuc3BvcnRcbiAgc2Vzc2lvblRva2VuPzogc3RyaW5nXG4gIHBhcnRTaXplPzogbnVtYmVyXG4gIHBhdGhTdHlsZT86IGJvb2xlYW5cbiAgY3JlZGVudGlhbHNQcm92aWRlcj86IENyZWRlbnRpYWxQcm92aWRlclxuICBzM0FjY2VsZXJhdGVFbmRwb2ludD86IHN0cmluZ1xuICB0cmFuc3BvcnRBZ2VudD86IGh0dHAuQWdlbnRcbn1cblxuZXhwb3J0IHR5cGUgUmVxdWVzdE9wdGlvbiA9IFBhcnRpYWw8SVJlcXVlc3Q+ICYge1xuICBtZXRob2Q6IHN0cmluZ1xuICBidWNrZXROYW1lPzogc3RyaW5nXG4gIG9iamVjdE5hbWU/OiBzdHJpbmdcbiAgcXVlcnk/OiBzdHJpbmdcbiAgcGF0aFN0eWxlPzogYm9vbGVhblxufVxuXG5leHBvcnQgdHlwZSBOb1Jlc3VsdENhbGxiYWNrID0gKGVycm9yOiB1bmtub3duKSA9PiB2b2lkXG5cbmV4cG9ydCBpbnRlcmZhY2UgTWFrZUJ1Y2tldE9wdCB7XG4gIE9iamVjdExvY2tpbmc/OiBib29sZWFuXG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgUmVtb3ZlT3B0aW9ucyB7XG4gIHZlcnNpb25JZD86IHN0cmluZ1xuICBnb3Zlcm5hbmNlQnlwYXNzPzogYm9vbGVhblxuICBmb3JjZURlbGV0ZT86IGJvb2xlYW5cbn1cblxudHlwZSBQYXJ0ID0ge1xuICBwYXJ0OiBudW1iZXJcbiAgZXRhZzogc3RyaW5nXG59XG5cbmV4cG9ydCBjbGFzcyBUeXBlZENsaWVudCB7XG4gIHByb3RlY3RlZCB0cmFuc3BvcnQ6IFRyYW5zcG9ydFxuICBwcm90ZWN0ZWQgaG9zdDogc3RyaW5nXG4gIHByb3RlY3RlZCBwb3J0OiBudW1iZXJcbiAgcHJvdGVjdGVkIHByb3RvY29sOiBzdHJpbmdcbiAgcHJvdGVjdGVkIGFjY2Vzc0tleTogc3RyaW5nXG4gIHByb3RlY3RlZCBzZWNyZXRLZXk6IHN0cmluZ1xuICBwcm90ZWN0ZWQgc2Vzc2lvblRva2VuPzogc3RyaW5nXG4gIHByb3RlY3RlZCB1c2VyQWdlbnQ6IHN0cmluZ1xuICBwcm90ZWN0ZWQgYW5vbnltb3VzOiBib29sZWFuXG4gIHByb3RlY3RlZCBwYXRoU3R5bGU6IGJvb2xlYW5cbiAgcHJvdGVjdGVkIHJlZ2lvbk1hcDogUmVjb3JkPHN0cmluZywgc3RyaW5nPlxuICBwdWJsaWMgcmVnaW9uPzogc3RyaW5nXG4gIHByb3RlY3RlZCBjcmVkZW50aWFsc1Byb3ZpZGVyPzogQ3JlZGVudGlhbFByb3ZpZGVyXG4gIHBhcnRTaXplOiBudW1iZXIgPSA2NCAqIDEwMjQgKiAxMDI0XG4gIHByb3RlY3RlZCBvdmVyUmlkZVBhcnRTaXplPzogYm9vbGVhblxuXG4gIHByb3RlY3RlZCBtYXhpbXVtUGFydFNpemUgPSA1ICogMTAyNCAqIDEwMjQgKiAxMDI0XG4gIHByb3RlY3RlZCBtYXhPYmplY3RTaXplID0gNSAqIDEwMjQgKiAxMDI0ICogMTAyNCAqIDEwMjRcbiAgcHVibGljIGVuYWJsZVNIQTI1NjogYm9vbGVhblxuICBwcm90ZWN0ZWQgczNBY2NlbGVyYXRlRW5kcG9pbnQ/OiBzdHJpbmdcbiAgcHJvdGVjdGVkIHJlcU9wdGlvbnM6IFJlY29yZDxzdHJpbmcsIHVua25vd24+XG5cbiAgcHJvdGVjdGVkIHRyYW5zcG9ydEFnZW50OiBodHRwLkFnZW50XG4gIHByaXZhdGUgcmVhZG9ubHkgY2xpZW50RXh0ZW5zaW9uczogRXh0ZW5zaW9uc1xuXG4gIGNvbnN0cnVjdG9yKHBhcmFtczogQ2xpZW50T3B0aW9ucykge1xuICAgIC8vIEB0cy1leHBlY3QtZXJyb3IgZGVwcmVjYXRlZCBwcm9wZXJ0eVxuICAgIGlmIChwYXJhbXMuc2VjdXJlICE9PSB1bmRlZmluZWQpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcignXCJzZWN1cmVcIiBvcHRpb24gZGVwcmVjYXRlZCwgXCJ1c2VTU0xcIiBzaG91bGQgYmUgdXNlZCBpbnN0ZWFkJylcbiAgICB9XG4gICAgLy8gRGVmYXVsdCB2YWx1ZXMgaWYgbm90IHNwZWNpZmllZC5cbiAgICBpZiAocGFyYW1zLnVzZVNTTCA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICBwYXJhbXMudXNlU1NMID0gdHJ1ZVxuICAgIH1cbiAgICBpZiAoIXBhcmFtcy5wb3J0KSB7XG4gICAgICBwYXJhbXMucG9ydCA9IDBcbiAgICB9XG4gICAgLy8gVmFsaWRhdGUgaW5wdXQgcGFyYW1zLlxuICAgIGlmICghaXNWYWxpZEVuZHBvaW50KHBhcmFtcy5lbmRQb2ludCkpIHtcbiAgICAgIHRocm93IG5ldyBlcnJvcnMuSW52YWxpZEVuZHBvaW50RXJyb3IoYEludmFsaWQgZW5kUG9pbnQgOiAke3BhcmFtcy5lbmRQb2ludH1gKVxuICAgIH1cbiAgICBpZiAoIWlzVmFsaWRQb3J0KHBhcmFtcy5wb3J0KSkge1xuICAgICAgdGhyb3cgbmV3IGVycm9ycy5JbnZhbGlkQXJndW1lbnRFcnJvcihgSW52YWxpZCBwb3J0IDogJHtwYXJhbXMucG9ydH1gKVxuICAgIH1cbiAgICBpZiAoIWlzQm9vbGVhbihwYXJhbXMudXNlU1NMKSkge1xuICAgICAgdGhyb3cgbmV3IGVycm9ycy5JbnZhbGlkQXJndW1lbnRFcnJvcihcbiAgICAgICAgYEludmFsaWQgdXNlU1NMIGZsYWcgdHlwZSA6ICR7cGFyYW1zLnVzZVNTTH0sIGV4cGVjdGVkIHRvIGJlIG9mIHR5cGUgXCJib29sZWFuXCJgLFxuICAgICAgKVxuICAgIH1cblxuICAgIC8vIFZhbGlkYXRlIHJlZ2lvbiBvbmx5IGlmIGl0cyBzZXQuXG4gICAgaWYgKHBhcmFtcy5yZWdpb24pIHtcbiAgICAgIGlmICghaXNTdHJpbmcocGFyYW1zLnJlZ2lvbikpIHtcbiAgICAgICAgdGhyb3cgbmV3IGVycm9ycy5JbnZhbGlkQXJndW1lbnRFcnJvcihgSW52YWxpZCByZWdpb24gOiAke3BhcmFtcy5yZWdpb259YClcbiAgICAgIH1cbiAgICB9XG5cbiAgICBjb25zdCBob3N0ID0gcGFyYW1zLmVuZFBvaW50LnRvTG93ZXJDYXNlKClcbiAgICBsZXQgcG9ydCA9IHBhcmFtcy5wb3J0XG4gICAgbGV0IHByb3RvY29sOiBzdHJpbmdcbiAgICBsZXQgdHJhbnNwb3J0XG4gICAgbGV0IHRyYW5zcG9ydEFnZW50OiBodHRwLkFnZW50XG4gICAgLy8gVmFsaWRhdGUgaWYgY29uZmlndXJhdGlvbiBpcyBub3QgdXNpbmcgU1NMXG4gICAgLy8gZm9yIGNvbnN0cnVjdGluZyByZWxldmFudCBlbmRwb2ludHMuXG4gICAgaWYgKHBhcmFtcy51c2VTU0wpIHtcbiAgICAgIC8vIERlZmF1bHRzIHRvIHNlY3VyZS5cbiAgICAgIHRyYW5zcG9ydCA9IGh0dHBzXG4gICAgICBwcm90b2NvbCA9ICdodHRwczonXG4gICAgICBwb3J0ID0gcG9ydCB8fCA0NDNcbiAgICAgIHRyYW5zcG9ydEFnZW50ID0gaHR0cHMuZ2xvYmFsQWdlbnRcbiAgICB9IGVsc2Uge1xuICAgICAgdHJhbnNwb3J0ID0gaHR0cFxuICAgICAgcHJvdG9jb2wgPSAnaHR0cDonXG4gICAgICBwb3J0ID0gcG9ydCB8fCA4MFxuICAgICAgdHJhbnNwb3J0QWdlbnQgPSBodHRwLmdsb2JhbEFnZW50XG4gICAgfVxuXG4gICAgLy8gaWYgY3VzdG9tIHRyYW5zcG9ydCBpcyBzZXQsIHVzZSBpdC5cbiAgICBpZiAocGFyYW1zLnRyYW5zcG9ydCkge1xuICAgICAgaWYgKCFpc09iamVjdChwYXJhbXMudHJhbnNwb3J0KSkge1xuICAgICAgICB0aHJvdyBuZXcgZXJyb3JzLkludmFsaWRBcmd1bWVudEVycm9yKFxuICAgICAgICAgIGBJbnZhbGlkIHRyYW5zcG9ydCB0eXBlIDogJHtwYXJhbXMudHJhbnNwb3J0fSwgZXhwZWN0ZWQgdG8gYmUgdHlwZSBcIm9iamVjdFwiYCxcbiAgICAgICAgKVxuICAgICAgfVxuICAgICAgdHJhbnNwb3J0ID0gcGFyYW1zLnRyYW5zcG9ydFxuICAgIH1cblxuICAgIC8vIGlmIGN1c3RvbSB0cmFuc3BvcnQgYWdlbnQgaXMgc2V0LCB1c2UgaXQuXG4gICAgaWYgKHBhcmFtcy50cmFuc3BvcnRBZ2VudCkge1xuICAgICAgaWYgKCFpc09iamVjdChwYXJhbXMudHJhbnNwb3J0QWdlbnQpKSB7XG4gICAgICAgIHRocm93IG5ldyBlcnJvcnMuSW52YWxpZEFyZ3VtZW50RXJyb3IoXG4gICAgICAgICAgYEludmFsaWQgdHJhbnNwb3J0QWdlbnQgdHlwZTogJHtwYXJhbXMudHJhbnNwb3J0QWdlbnR9LCBleHBlY3RlZCB0byBiZSB0eXBlIFwib2JqZWN0XCJgLFxuICAgICAgICApXG4gICAgICB9XG5cbiAgICAgIHRyYW5zcG9ydEFnZW50ID0gcGFyYW1zLnRyYW5zcG9ydEFnZW50XG4gICAgfVxuXG4gICAgLy8gVXNlciBBZ2VudCBzaG91bGQgYWx3YXlzIGZvbGxvd2luZyB0aGUgYmVsb3cgc3R5bGUuXG4gICAgLy8gUGxlYXNlIG9wZW4gYW4gaXNzdWUgdG8gZGlzY3VzcyBhbnkgbmV3IGNoYW5nZXMgaGVyZS5cbiAgICAvL1xuICAgIC8vICAgICAgIE1pbklPIChPUzsgQVJDSCkgTElCL1ZFUiBBUFAvVkVSXG4gICAgLy9cbiAgICBjb25zdCBsaWJyYXJ5Q29tbWVudHMgPSBgKCR7cHJvY2Vzcy5wbGF0Zm9ybX07ICR7cHJvY2Vzcy5hcmNofSlgXG4gICAgY29uc3QgbGlicmFyeUFnZW50ID0gYE1pbklPICR7bGlicmFyeUNvbW1lbnRzfSBtaW5pby1qcy8ke1BhY2thZ2UudmVyc2lvbn1gXG4gICAgLy8gVXNlciBhZ2VudCBibG9jayBlbmRzLlxuXG4gICAgdGhpcy50cmFuc3BvcnQgPSB0cmFuc3BvcnRcbiAgICB0aGlzLnRyYW5zcG9ydEFnZW50ID0gdHJhbnNwb3J0QWdlbnRcbiAgICB0aGlzLmhvc3QgPSBob3N0XG4gICAgdGhpcy5wb3J0ID0gcG9ydFxuICAgIHRoaXMucHJvdG9jb2wgPSBwcm90b2NvbFxuICAgIHRoaXMudXNlckFnZW50ID0gYCR7bGlicmFyeUFnZW50fWBcblxuICAgIC8vIERlZmF1bHQgcGF0aCBzdHlsZSBpcyB0cnVlXG4gICAgaWYgKHBhcmFtcy5wYXRoU3R5bGUgPT09IHVuZGVmaW5lZCkge1xuICAgICAgdGhpcy5wYXRoU3R5bGUgPSB0cnVlXG4gICAgfSBlbHNlIHtcbiAgICAgIHRoaXMucGF0aFN0eWxlID0gcGFyYW1zLnBhdGhTdHlsZVxuICAgIH1cblxuICAgIHRoaXMuYWNjZXNzS2V5ID0gcGFyYW1zLmFjY2Vzc0tleSA/PyAnJ1xuICAgIHRoaXMuc2VjcmV0S2V5ID0gcGFyYW1zLnNlY3JldEtleSA/PyAnJ1xuICAgIHRoaXMuc2Vzc2lvblRva2VuID0gcGFyYW1zLnNlc3Npb25Ub2tlblxuICAgIHRoaXMuYW5vbnltb3VzID0gIXRoaXMuYWNjZXNzS2V5IHx8ICF0aGlzLnNlY3JldEtleVxuXG4gICAgaWYgKHBhcmFtcy5jcmVkZW50aWFsc1Byb3ZpZGVyKSB7XG4gICAgICB0aGlzLmFub255bW91cyA9IGZhbHNlXG4gICAgICB0aGlzLmNyZWRlbnRpYWxzUHJvdmlkZXIgPSBwYXJhbXMuY3JlZGVudGlhbHNQcm92aWRlclxuICAgIH1cblxuICAgIHRoaXMucmVnaW9uTWFwID0ge31cbiAgICBpZiAocGFyYW1zLnJlZ2lvbikge1xuICAgICAgdGhpcy5yZWdpb24gPSBwYXJhbXMucmVnaW9uXG4gICAgfVxuXG4gICAgaWYgKHBhcmFtcy5wYXJ0U2l6ZSkge1xuICAgICAgdGhpcy5wYXJ0U2l6ZSA9IHBhcmFtcy5wYXJ0U2l6ZVxuICAgICAgdGhpcy5vdmVyUmlkZVBhcnRTaXplID0gdHJ1ZVxuICAgIH1cbiAgICBpZiAodGhpcy5wYXJ0U2l6ZSA8IDUgKiAxMDI0ICogMTAyNCkge1xuICAgICAgdGhyb3cgbmV3IGVycm9ycy5JbnZhbGlkQXJndW1lbnRFcnJvcihgUGFydCBzaXplIHNob3VsZCBiZSBncmVhdGVyIHRoYW4gNU1CYClcbiAgICB9XG4gICAgaWYgKHRoaXMucGFydFNpemUgPiA1ICogMTAyNCAqIDEwMjQgKiAxMDI0KSB7XG4gICAgICB0aHJvdyBuZXcgZXJyb3JzLkludmFsaWRBcmd1bWVudEVycm9yKGBQYXJ0IHNpemUgc2hvdWxkIGJlIGxlc3MgdGhhbiA1R0JgKVxuICAgIH1cblxuICAgIC8vIFNIQTI1NiBpcyBlbmFibGVkIG9ubHkgZm9yIGF1dGhlbnRpY2F0ZWQgaHR0cCByZXF1ZXN0cy4gSWYgdGhlIHJlcXVlc3QgaXMgYXV0aGVudGljYXRlZFxuICAgIC8vIGFuZCB0aGUgY29ubmVjdGlvbiBpcyBodHRwcyB3ZSB1c2UgeC1hbXotY29udGVudC1zaGEyNTY9VU5TSUdORUQtUEFZTE9BRFxuICAgIC8vIGhlYWRlciBmb3Igc2lnbmF0dXJlIGNhbGN1bGF0aW9uLlxuICAgIHRoaXMuZW5hYmxlU0hBMjU2ID0gIXRoaXMuYW5vbnltb3VzICYmICFwYXJhbXMudXNlU1NMXG5cbiAgICB0aGlzLnMzQWNjZWxlcmF0ZUVuZHBvaW50ID0gcGFyYW1zLnMzQWNjZWxlcmF0ZUVuZHBvaW50IHx8IHVuZGVmaW5lZFxuICAgIHRoaXMucmVxT3B0aW9ucyA9IHt9XG4gICAgdGhpcy5jbGllbnRFeHRlbnNpb25zID0gbmV3IEV4dGVuc2lvbnModGhpcylcbiAgfVxuICAvKipcbiAgICogTWluaW8gZXh0ZW5zaW9ucyB0aGF0IGFyZW4ndCBuZWNlc3NhcnkgcHJlc2VudCBmb3IgQW1hem9uIFMzIGNvbXBhdGlibGUgc3RvcmFnZSBzZXJ2ZXJzXG4gICAqL1xuICBnZXQgZXh0ZW5zaW9ucygpIHtcbiAgICByZXR1cm4gdGhpcy5jbGllbnRFeHRlbnNpb25zXG4gIH1cblxuICAvKipcbiAgICogQHBhcmFtIGVuZFBvaW50IC0gdmFsaWQgUzMgYWNjZWxlcmF0aW9uIGVuZCBwb2ludFxuICAgKi9cbiAgc2V0UzNUcmFuc2ZlckFjY2VsZXJhdGUoZW5kUG9pbnQ6IHN0cmluZykge1xuICAgIHRoaXMuczNBY2NlbGVyYXRlRW5kcG9pbnQgPSBlbmRQb2ludFxuICB9XG5cbiAgLyoqXG4gICAqIFNldHMgdGhlIHN1cHBvcnRlZCByZXF1ZXN0IG9wdGlvbnMuXG4gICAqL1xuICBwdWJsaWMgc2V0UmVxdWVzdE9wdGlvbnMob3B0aW9uczogUGljazxodHRwcy5SZXF1ZXN0T3B0aW9ucywgKHR5cGVvZiByZXF1ZXN0T3B0aW9uUHJvcGVydGllcylbbnVtYmVyXT4pIHtcbiAgICBpZiAoIWlzT2JqZWN0KG9wdGlvbnMpKSB7XG4gICAgICB0aHJvdyBuZXcgVHlwZUVycm9yKCdyZXF1ZXN0IG9wdGlvbnMgc2hvdWxkIGJlIG9mIHR5cGUgXCJvYmplY3RcIicpXG4gICAgfVxuICAgIHRoaXMucmVxT3B0aW9ucyA9IF8ucGljayhvcHRpb25zLCByZXF1ZXN0T3B0aW9uUHJvcGVydGllcylcbiAgfVxuXG4gIC8qKlxuICAgKiAgVGhpcyBpcyBzMyBTcGVjaWZpYyBhbmQgZG9lcyBub3QgaG9sZCB2YWxpZGl0eSBpbiBhbnkgb3RoZXIgT2JqZWN0IHN0b3JhZ2UuXG4gICAqL1xuICBwcml2YXRlIGdldEFjY2VsZXJhdGVFbmRQb2ludElmU2V0KGJ1Y2tldE5hbWU/OiBzdHJpbmcsIG9iamVjdE5hbWU/OiBzdHJpbmcpIHtcbiAgICBpZiAoIWlzRW1wdHkodGhpcy5zM0FjY2VsZXJhdGVFbmRwb2ludCkgJiYgIWlzRW1wdHkoYnVja2V0TmFtZSkgJiYgIWlzRW1wdHkob2JqZWN0TmFtZSkpIHtcbiAgICAgIC8vIGh0dHA6Ly9kb2NzLmF3cy5hbWF6b24uY29tL0FtYXpvblMzL2xhdGVzdC9kZXYvdHJhbnNmZXItYWNjZWxlcmF0aW9uLmh0bWxcbiAgICAgIC8vIERpc2FibGUgdHJhbnNmZXIgYWNjZWxlcmF0aW9uIGZvciBub24tY29tcGxpYW50IGJ1Y2tldCBuYW1lcy5cbiAgICAgIGlmIChidWNrZXROYW1lLmluY2x1ZGVzKCcuJykpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBUcmFuc2ZlciBBY2NlbGVyYXRpb24gaXMgbm90IHN1cHBvcnRlZCBmb3Igbm9uIGNvbXBsaWFudCBidWNrZXQ6JHtidWNrZXROYW1lfWApXG4gICAgICB9XG4gICAgICAvLyBJZiB0cmFuc2ZlciBhY2NlbGVyYXRpb24gaXMgcmVxdWVzdGVkIHNldCBuZXcgaG9zdC5cbiAgICAgIC8vIEZvciBtb3JlIGRldGFpbHMgYWJvdXQgZW5hYmxpbmcgdHJhbnNmZXIgYWNjZWxlcmF0aW9uIHJlYWQgaGVyZS5cbiAgICAgIC8vIGh0dHA6Ly9kb2NzLmF3cy5hbWF6b24uY29tL0FtYXpvblMzL2xhdGVzdC9kZXYvdHJhbnNmZXItYWNjZWxlcmF0aW9uLmh0bWxcbiAgICAgIHJldHVybiB0aGlzLnMzQWNjZWxlcmF0ZUVuZHBvaW50XG4gICAgfVxuICAgIHJldHVybiBmYWxzZVxuICB9XG5cbiAgLyoqXG4gICAqICAgU2V0IGFwcGxpY2F0aW9uIHNwZWNpZmljIGluZm9ybWF0aW9uLlxuICAgKiAgIEdlbmVyYXRlcyBVc2VyLUFnZW50IGluIHRoZSBmb2xsb3dpbmcgc3R5bGUuXG4gICAqICAgTWluSU8gKE9TOyBBUkNIKSBMSUIvVkVSIEFQUC9WRVJcbiAgICovXG4gIHNldEFwcEluZm8oYXBwTmFtZTogc3RyaW5nLCBhcHBWZXJzaW9uOiBzdHJpbmcpIHtcbiAgICBpZiAoIWlzU3RyaW5nKGFwcE5hbWUpKSB7XG4gICAgICB0aHJvdyBuZXcgVHlwZUVycm9yKGBJbnZhbGlkIGFwcE5hbWU6ICR7YXBwTmFtZX1gKVxuICAgIH1cbiAgICBpZiAoYXBwTmFtZS50cmltKCkgPT09ICcnKSB7XG4gICAgICB0aHJvdyBuZXcgZXJyb3JzLkludmFsaWRBcmd1bWVudEVycm9yKCdJbnB1dCBhcHBOYW1lIGNhbm5vdCBiZSBlbXB0eS4nKVxuICAgIH1cbiAgICBpZiAoIWlzU3RyaW5nKGFwcFZlcnNpb24pKSB7XG4gICAgICB0aHJvdyBuZXcgVHlwZUVycm9yKGBJbnZhbGlkIGFwcFZlcnNpb246ICR7YXBwVmVyc2lvbn1gKVxuICAgIH1cbiAgICBpZiAoYXBwVmVyc2lvbi50cmltKCkgPT09ICcnKSB7XG4gICAgICB0aHJvdyBuZXcgZXJyb3JzLkludmFsaWRBcmd1bWVudEVycm9yKCdJbnB1dCBhcHBWZXJzaW9uIGNhbm5vdCBiZSBlbXB0eS4nKVxuICAgIH1cbiAgICB0aGlzLnVzZXJBZ2VudCA9IGAke3RoaXMudXNlckFnZW50fSAke2FwcE5hbWV9LyR7YXBwVmVyc2lvbn1gXG4gIH1cblxuICAvKipcbiAgICogcmV0dXJucyBvcHRpb25zIG9iamVjdCB0aGF0IGNhbiBiZSB1c2VkIHdpdGggaHR0cC5yZXF1ZXN0KClcbiAgICogVGFrZXMgY2FyZSBvZiBjb25zdHJ1Y3RpbmcgdmlydHVhbC1ob3N0LXN0eWxlIG9yIHBhdGgtc3R5bGUgaG9zdG5hbWVcbiAgICovXG4gIHByb3RlY3RlZCBnZXRSZXF1ZXN0T3B0aW9ucyhcbiAgICBvcHRzOiBSZXF1ZXN0T3B0aW9uICYge1xuICAgICAgcmVnaW9uOiBzdHJpbmdcbiAgICB9LFxuICApOiBJUmVxdWVzdCAmIHtcbiAgICBob3N0OiBzdHJpbmdcbiAgICBoZWFkZXJzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+XG4gIH0ge1xuICAgIGNvbnN0IG1ldGhvZCA9IG9wdHMubWV0aG9kXG4gICAgY29uc3QgcmVnaW9uID0gb3B0cy5yZWdpb25cbiAgICBjb25zdCBidWNrZXROYW1lID0gb3B0cy5idWNrZXROYW1lXG4gICAgbGV0IG9iamVjdE5hbWUgPSBvcHRzLm9iamVjdE5hbWVcbiAgICBjb25zdCBoZWFkZXJzID0gb3B0cy5oZWFkZXJzXG4gICAgY29uc3QgcXVlcnkgPSBvcHRzLnF1ZXJ5XG5cbiAgICBsZXQgcmVxT3B0aW9ucyA9IHtcbiAgICAgIG1ldGhvZCxcbiAgICAgIGhlYWRlcnM6IHt9IGFzIFJlcXVlc3RIZWFkZXJzLFxuICAgICAgcHJvdG9jb2w6IHRoaXMucHJvdG9jb2wsXG4gICAgICAvLyBJZiBjdXN0b20gdHJhbnNwb3J0QWdlbnQgd2FzIHN1cHBsaWVkIGVhcmxpZXIsIHdlJ2xsIGluamVjdCBpdCBoZXJlXG4gICAgICBhZ2VudDogdGhpcy50cmFuc3BvcnRBZ2VudCxcbiAgICB9XG5cbiAgICAvLyBWZXJpZnkgaWYgdmlydHVhbCBob3N0IHN1cHBvcnRlZC5cbiAgICBsZXQgdmlydHVhbEhvc3RTdHlsZVxuICAgIGlmIChidWNrZXROYW1lKSB7XG4gICAgICB2aXJ0dWFsSG9zdFN0eWxlID0gaXNWaXJ0dWFsSG9zdFN0eWxlKHRoaXMuaG9zdCwgdGhpcy5wcm90b2NvbCwgYnVja2V0TmFtZSwgdGhpcy5wYXRoU3R5bGUpXG4gICAgfVxuXG4gICAgbGV0IHBhdGggPSAnLydcbiAgICBsZXQgaG9zdCA9IHRoaXMuaG9zdFxuXG4gICAgbGV0IHBvcnQ6IHVuZGVmaW5lZCB8IG51bWJlclxuICAgIGlmICh0aGlzLnBvcnQpIHtcbiAgICAgIHBvcnQgPSB0aGlzLnBvcnRcbiAgICB9XG5cbiAgICBpZiAob2JqZWN0TmFtZSkge1xuICAgICAgb2JqZWN0TmFtZSA9IHVyaVJlc291cmNlRXNjYXBlKG9iamVjdE5hbWUpXG4gICAgfVxuXG4gICAgLy8gRm9yIEFtYXpvbiBTMyBlbmRwb2ludCwgZ2V0IGVuZHBvaW50IGJhc2VkIG9uIHJlZ2lvbi5cbiAgICBpZiAoaXNBbWF6b25FbmRwb2ludChob3N0KSkge1xuICAgICAgY29uc3QgYWNjZWxlcmF0ZUVuZFBvaW50ID0gdGhpcy5nZXRBY2NlbGVyYXRlRW5kUG9pbnRJZlNldChidWNrZXROYW1lLCBvYmplY3ROYW1lKVxuICAgICAgaWYgKGFjY2VsZXJhdGVFbmRQb2ludCkge1xuICAgICAgICBob3N0ID0gYCR7YWNjZWxlcmF0ZUVuZFBvaW50fWBcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGhvc3QgPSBnZXRTM0VuZHBvaW50KHJlZ2lvbilcbiAgICAgIH1cbiAgICB9XG5cbiAgICBpZiAodmlydHVhbEhvc3RTdHlsZSAmJiAhb3B0cy5wYXRoU3R5bGUpIHtcbiAgICAgIC8vIEZvciBhbGwgaG9zdHMgd2hpY2ggc3VwcG9ydCB2aXJ0dWFsIGhvc3Qgc3R5bGUsIGBidWNrZXROYW1lYFxuICAgICAgLy8gaXMgcGFydCBvZiB0aGUgaG9zdG5hbWUgaW4gdGhlIGZvbGxvd2luZyBmb3JtYXQ6XG4gICAgICAvL1xuICAgICAgLy8gIHZhciBob3N0ID0gJ2J1Y2tldE5hbWUuZXhhbXBsZS5jb20nXG4gICAgICAvL1xuICAgICAgaWYgKGJ1Y2tldE5hbWUpIHtcbiAgICAgICAgaG9zdCA9IGAke2J1Y2tldE5hbWV9LiR7aG9zdH1gXG4gICAgICB9XG4gICAgICBpZiAob2JqZWN0TmFtZSkge1xuICAgICAgICBwYXRoID0gYC8ke29iamVjdE5hbWV9YFxuICAgICAgfVxuICAgIH0gZWxzZSB7XG4gICAgICAvLyBGb3IgYWxsIFMzIGNvbXBhdGlibGUgc3RvcmFnZSBzZXJ2aWNlcyB3ZSB3aWxsIGZhbGxiYWNrIHRvXG4gICAgICAvLyBwYXRoIHN0eWxlIHJlcXVlc3RzLCB3aGVyZSBgYnVja2V0TmFtZWAgaXMgcGFydCBvZiB0aGUgVVJJXG4gICAgICAvLyBwYXRoLlxuICAgICAgaWYgKGJ1Y2tldE5hbWUpIHtcbiAgICAgICAgcGF0aCA9IGAvJHtidWNrZXROYW1lfWBcbiAgICAgIH1cbiAgICAgIGlmIChvYmplY3ROYW1lKSB7XG4gICAgICAgIHBhdGggPSBgLyR7YnVja2V0TmFtZX0vJHtvYmplY3ROYW1lfWBcbiAgICAgIH1cbiAgICB9XG5cbiAgICBpZiAocXVlcnkpIHtcbiAgICAgIHBhdGggKz0gYD8ke3F1ZXJ5fWBcbiAgICB9XG4gICAgcmVxT3B0aW9ucy5oZWFkZXJzLmhvc3QgPSBob3N0XG4gICAgaWYgKChyZXFPcHRpb25zLnByb3RvY29sID09PSAnaHR0cDonICYmIHBvcnQgIT09IDgwKSB8fCAocmVxT3B0aW9ucy5wcm90b2NvbCA9PT0gJ2h0dHBzOicgJiYgcG9ydCAhPT0gNDQzKSkge1xuICAgICAgcmVxT3B0aW9ucy5oZWFkZXJzLmhvc3QgPSBqb2luSG9zdFBvcnQoaG9zdCwgcG9ydClcbiAgICB9XG5cbiAgICByZXFPcHRpb25zLmhlYWRlcnNbJ3VzZXItYWdlbnQnXSA9IHRoaXMudXNlckFnZW50XG4gICAgaWYgKGhlYWRlcnMpIHtcbiAgICAgIC8vIGhhdmUgYWxsIGhlYWRlciBrZXlzIGluIGxvd2VyIGNhc2UgLSB0byBtYWtlIHNpZ25pbmcgZWFzeVxuICAgICAgZm9yIChjb25zdCBbaywgdl0gb2YgT2JqZWN0LmVudHJpZXMoaGVhZGVycykpIHtcbiAgICAgICAgcmVxT3B0aW9ucy5oZWFkZXJzW2sudG9Mb3dlckNhc2UoKV0gPSB2XG4gICAgICB9XG4gICAgfVxuXG4gICAgLy8gVXNlIGFueSByZXF1ZXN0IG9wdGlvbiBzcGVjaWZpZWQgaW4gbWluaW9DbGllbnQuc2V0UmVxdWVzdE9wdGlvbnMoKVxuICAgIHJlcU9wdGlvbnMgPSBPYmplY3QuYXNzaWduKHt9LCB0aGlzLnJlcU9wdGlvbnMsIHJlcU9wdGlvbnMpXG5cbiAgICByZXR1cm4ge1xuICAgICAgLi4ucmVxT3B0aW9ucyxcbiAgICAgIGhlYWRlcnM6IF8ubWFwVmFsdWVzKF8ucGlja0J5KHJlcU9wdGlvbnMuaGVhZGVycywgaXNEZWZpbmVkKSwgKHYpID0+IHYudG9TdHJpbmcoKSksXG4gICAgICBob3N0LFxuICAgICAgcG9ydCxcbiAgICAgIHBhdGgsXG4gICAgfSBzYXRpc2ZpZXMgaHR0cHMuUmVxdWVzdE9wdGlvbnNcbiAgfVxuXG4gIHB1YmxpYyBhc3luYyBzZXRDcmVkZW50aWFsc1Byb3ZpZGVyKGNyZWRlbnRpYWxzUHJvdmlkZXI6IENyZWRlbnRpYWxQcm92aWRlcikge1xuICAgIGlmICghKGNyZWRlbnRpYWxzUHJvdmlkZXIgaW5zdGFuY2VvZiBDcmVkZW50aWFsUHJvdmlkZXIpKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoJ1VuYWJsZSB0byBnZXQgY3JlZGVudGlhbHMuIEV4cGVjdGVkIGluc3RhbmNlIG9mIENyZWRlbnRpYWxQcm92aWRlcicpXG4gICAgfVxuICAgIHRoaXMuY3JlZGVudGlhbHNQcm92aWRlciA9IGNyZWRlbnRpYWxzUHJvdmlkZXJcbiAgICBhd2FpdCB0aGlzLmNoZWNrQW5kUmVmcmVzaENyZWRzKClcbiAgfVxuXG4gIHByaXZhdGUgYXN5bmMgY2hlY2tBbmRSZWZyZXNoQ3JlZHMoKSB7XG4gICAgaWYgKHRoaXMuY3JlZGVudGlhbHNQcm92aWRlcikge1xuICAgICAgdHJ5IHtcbiAgICAgICAgY29uc3QgY3JlZGVudGlhbHNDb25mID0gYXdhaXQgdGhpcy5jcmVkZW50aWFsc1Byb3ZpZGVyLmdldENyZWRlbnRpYWxzKClcbiAgICAgICAgdGhpcy5hY2Nlc3NLZXkgPSBjcmVkZW50aWFsc0NvbmYuZ2V0QWNjZXNzS2V5KClcbiAgICAgICAgdGhpcy5zZWNyZXRLZXkgPSBjcmVkZW50aWFsc0NvbmYuZ2V0U2VjcmV0S2V5KClcbiAgICAgICAgdGhpcy5zZXNzaW9uVG9rZW4gPSBjcmVkZW50aWFsc0NvbmYuZ2V0U2Vzc2lvblRva2VuKClcbiAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBVbmFibGUgdG8gZ2V0IGNyZWRlbnRpYWxzOiAke2V9YCwgeyBjYXVzZTogZSB9KVxuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIHByaXZhdGUgbG9nU3RyZWFtPzogc3RyZWFtLldyaXRhYmxlXG5cbiAgLyoqXG4gICAqIGxvZyB0aGUgcmVxdWVzdCwgcmVzcG9uc2UsIGVycm9yXG4gICAqL1xuICBwcml2YXRlIGxvZ0hUVFAocmVxT3B0aW9uczogSVJlcXVlc3QsIHJlc3BvbnNlOiBodHRwLkluY29taW5nTWVzc2FnZSB8IG51bGwsIGVycj86IHVua25vd24pIHtcbiAgICAvLyBpZiBubyBsb2dTdHJlYW0gYXZhaWxhYmxlIHJldHVybi5cbiAgICBpZiAoIXRoaXMubG9nU3RyZWFtKSB7XG4gICAgICByZXR1cm5cbiAgICB9XG4gICAgaWYgKCFpc09iamVjdChyZXFPcHRpb25zKSkge1xuICAgICAgdGhyb3cgbmV3IFR5cGVFcnJvcigncmVxT3B0aW9ucyBzaG91bGQgYmUgb2YgdHlwZSBcIm9iamVjdFwiJylcbiAgICB9XG4gICAgaWYgKHJlc3BvbnNlICYmICFpc1JlYWRhYmxlU3RyZWFtKHJlc3BvbnNlKSkge1xuICAgICAgdGhyb3cgbmV3IFR5cGVFcnJvcigncmVzcG9uc2Ugc2hvdWxkIGJlIG9mIHR5cGUgXCJTdHJlYW1cIicpXG4gICAgfVxuICAgIGlmIChlcnIgJiYgIShlcnIgaW5zdGFuY2VvZiBFcnJvcikpIHtcbiAgICAgIHRocm93IG5ldyBUeXBlRXJyb3IoJ2VyciBzaG91bGQgYmUgb2YgdHlwZSBcIkVycm9yXCInKVxuICAgIH1cbiAgICBjb25zdCBsb2dTdHJlYW0gPSB0aGlzLmxvZ1N0cmVhbVxuICAgIGNvbnN0IGxvZ0hlYWRlcnMgPSAoaGVhZGVyczogUmVxdWVzdEhlYWRlcnMpID0+IHtcbiAgICAgIE9iamVjdC5lbnRyaWVzKGhlYWRlcnMpLmZvckVhY2goKFtrLCB2XSkgPT4ge1xuICAgICAgICBpZiAoayA9PSAnYXV0aG9yaXphdGlvbicpIHtcbiAgICAgICAgICBpZiAoaXNTdHJpbmcodikpIHtcbiAgICAgICAgICAgIGNvbnN0IHJlZGFjdG9yID0gbmV3IFJlZ0V4cCgnU2lnbmF0dXJlPShbMC05YS1mXSspJylcbiAgICAgICAgICAgIHYgPSB2LnJlcGxhY2UocmVkYWN0b3IsICdTaWduYXR1cmU9KipSRURBQ1RFRCoqJylcbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICAgbG9nU3RyZWFtLndyaXRlKGAke2t9OiAke3Z9XFxuYClcbiAgICAgIH0pXG4gICAgICBsb2dTdHJlYW0ud3JpdGUoJ1xcbicpXG4gICAgfVxuICAgIGxvZ1N0cmVhbS53cml0ZShgUkVRVUVTVDogJHtyZXFPcHRpb25zLm1ldGhvZH0gJHtyZXFPcHRpb25zLnBhdGh9XFxuYClcbiAgICBsb2dIZWFkZXJzKHJlcU9wdGlvbnMuaGVhZGVycylcbiAgICBpZiAocmVzcG9uc2UpIHtcbiAgICAgIHRoaXMubG9nU3RyZWFtLndyaXRlKGBSRVNQT05TRTogJHtyZXNwb25zZS5zdGF0dXNDb2RlfVxcbmApXG4gICAgICBsb2dIZWFkZXJzKHJlc3BvbnNlLmhlYWRlcnMgYXMgUmVxdWVzdEhlYWRlcnMpXG4gICAgfVxuICAgIGlmIChlcnIpIHtcbiAgICAgIGxvZ1N0cmVhbS53cml0ZSgnRVJST1IgQk9EWTpcXG4nKVxuICAgICAgY29uc3QgZXJySlNPTiA9IEpTT04uc3RyaW5naWZ5KGVyciwgbnVsbCwgJ1xcdCcpXG4gICAgICBsb2dTdHJlYW0ud3JpdGUoYCR7ZXJySlNPTn1cXG5gKVxuICAgIH1cbiAgfVxuXG4gIC8qKlxuICAgKiBFbmFibGUgdHJhY2luZ1xuICAgKi9cbiAgcHVibGljIHRyYWNlT24oc3RyZWFtPzogc3RyZWFtLldyaXRhYmxlKSB7XG4gICAgaWYgKCFzdHJlYW0pIHtcbiAgICAgIHN0cmVhbSA9IHByb2Nlc3Muc3Rkb3V0XG4gICAgfVxuICAgIHRoaXMubG9nU3RyZWFtID0gc3RyZWFtXG4gIH1cblxuICAvKipcbiAgICogRGlzYWJsZSB0cmFjaW5nXG4gICAqL1xuICBwdWJsaWMgdHJhY2VPZmYoKSB7XG4gICAgdGhpcy5sb2dTdHJlYW0gPSB1bmRlZmluZWRcbiAgfVxuXG4gIC8qKlxuICAgKiBtYWtlUmVxdWVzdCBpcyB0aGUgcHJpbWl0aXZlIHVzZWQgYnkgdGhlIGFwaXMgZm9yIG1ha2luZyBTMyByZXF1ZXN0cy5cbiAgICogcGF5bG9hZCBjYW4gYmUgZW1wdHkgc3RyaW5nIGluIGNhc2Ugb2Ygbm8gcGF5bG9hZC5cbiAgICogc3RhdHVzQ29kZSBpcyB0aGUgZXhwZWN0ZWQgc3RhdHVzQ29kZS4gSWYgcmVzcG9uc2Uuc3RhdHVzQ29kZSBkb2VzIG5vdCBtYXRjaFxuICAgKiB3ZSBwYXJzZSB0aGUgWE1MIGVycm9yIGFuZCBjYWxsIHRoZSBjYWxsYmFjayB3aXRoIHRoZSBlcnJvciBtZXNzYWdlLlxuICAgKlxuICAgKiBBIHZhbGlkIHJlZ2lvbiBpcyBwYXNzZWQgYnkgdGhlIGNhbGxzIC0gbGlzdEJ1Y2tldHMsIG1ha2VCdWNrZXQgYW5kIGdldEJ1Y2tldFJlZ2lvbi5cbiAgICpcbiAgICogQGludGVybmFsXG4gICAqL1xuICBhc3luYyBtYWtlUmVxdWVzdEFzeW5jKFxuICAgIG9wdGlvbnM6IFJlcXVlc3RPcHRpb24sXG4gICAgcGF5bG9hZDogQmluYXJ5ID0gJycsXG4gICAgZXhwZWN0ZWRDb2RlczogbnVtYmVyW10gPSBbMjAwXSxcbiAgICByZWdpb24gPSAnJyxcbiAgKTogUHJvbWlzZTxodHRwLkluY29taW5nTWVzc2FnZT4ge1xuICAgIGlmICghaXNPYmplY3Qob3B0aW9ucykpIHtcbiAgICAgIHRocm93IG5ldyBUeXBlRXJyb3IoJ29wdGlvbnMgc2hvdWxkIGJlIG9mIHR5cGUgXCJvYmplY3RcIicpXG4gICAgfVxuICAgIGlmICghaXNTdHJpbmcocGF5bG9hZCkgJiYgIWlzT2JqZWN0KHBheWxvYWQpKSB7XG4gICAgICAvLyBCdWZmZXIgaXMgb2YgdHlwZSAnb2JqZWN0J1xuICAgICAgdGhyb3cgbmV3IFR5cGVFcnJvcigncGF5bG9hZCBzaG91bGQgYmUgb2YgdHlwZSBcInN0cmluZ1wiIG9yIFwiQnVmZmVyXCInKVxuICAgIH1cbiAgICBleHBlY3RlZENvZGVzLmZvckVhY2goKHN0YXR1c0NvZGUpID0+IHtcbiAgICAgIGlmICghaXNOdW1iZXIoc3RhdHVzQ29kZSkpIHtcbiAgICAgICAgdGhyb3cgbmV3IFR5cGVFcnJvcignc3RhdHVzQ29kZSBzaG91bGQgYmUgb2YgdHlwZSBcIm51bWJlclwiJylcbiAgICAgIH1cbiAgICB9KVxuICAgIGlmICghaXNTdHJpbmcocmVnaW9uKSkge1xuICAgICAgdGhyb3cgbmV3IFR5cGVFcnJvcigncmVnaW9uIHNob3VsZCBiZSBvZiB0eXBlIFwic3RyaW5nXCInKVxuICAgIH1cbiAgICBpZiAoIW9wdGlvbnMuaGVhZGVycykge1xuICAgICAgb3B0aW9ucy5oZWFkZXJzID0ge31cbiAgICB9XG4gICAgaWYgKG9wdGlvbnMubWV0aG9kID09PSAnUE9TVCcgfHwgb3B0aW9ucy5tZXRob2QgPT09ICdQVVQnIHx8IG9wdGlvbnMubWV0aG9kID09PSAnREVMRVRFJykge1xuICAgICAgb3B0aW9ucy5oZWFkZXJzWydjb250ZW50LWxlbmd0aCddID0gcGF5bG9hZC5sZW5ndGgudG9TdHJpbmcoKVxuICAgIH1cbiAgICBjb25zdCBzaGEyNTZzdW0gPSB0aGlzLmVuYWJsZVNIQTI1NiA/IHRvU2hhMjU2KHBheWxvYWQpIDogJydcbiAgICByZXR1cm4gdGhpcy5tYWtlUmVxdWVzdFN0cmVhbUFzeW5jKG9wdGlvbnMsIHBheWxvYWQsIHNoYTI1NnN1bSwgZXhwZWN0ZWRDb2RlcywgcmVnaW9uKVxuICB9XG5cbiAgLyoqXG4gICAqIG5ldyByZXF1ZXN0IHdpdGggcHJvbWlzZVxuICAgKlxuICAgKiBObyBuZWVkIHRvIGRyYWluIHJlc3BvbnNlLCByZXNwb25zZSBib2R5IGlzIG5vdCB2YWxpZFxuICAgKi9cbiAgYXN5bmMgbWFrZVJlcXVlc3RBc3luY09taXQoXG4gICAgb3B0aW9uczogUmVxdWVzdE9wdGlvbixcbiAgICBwYXlsb2FkOiBCaW5hcnkgPSAnJyxcbiAgICBzdGF0dXNDb2RlczogbnVtYmVyW10gPSBbMjAwXSxcbiAgICByZWdpb24gPSAnJyxcbiAgKTogUHJvbWlzZTxPbWl0PGh0dHAuSW5jb21pbmdNZXNzYWdlLCAnb24nPj4ge1xuICAgIGNvbnN0IHJlcyA9IGF3YWl0IHRoaXMubWFrZVJlcXVlc3RBc3luYyhvcHRpb25zLCBwYXlsb2FkLCBzdGF0dXNDb2RlcywgcmVnaW9uKVxuICAgIGF3YWl0IGRyYWluUmVzcG9uc2UocmVzKVxuICAgIHJldHVybiByZXNcbiAgfVxuXG4gIC8qKlxuICAgKiBtYWtlUmVxdWVzdFN0cmVhbSB3aWxsIGJlIHVzZWQgZGlyZWN0bHkgaW5zdGVhZCBvZiBtYWtlUmVxdWVzdCBpbiBjYXNlIHRoZSBwYXlsb2FkXG4gICAqIGlzIGF2YWlsYWJsZSBhcyBhIHN0cmVhbS4gZm9yIGV4LiBwdXRPYmplY3RcbiAgICpcbiAgICogQGludGVybmFsXG4gICAqL1xuICBhc3luYyBtYWtlUmVxdWVzdFN0cmVhbUFzeW5jKFxuICAgIG9wdGlvbnM6IFJlcXVlc3RPcHRpb24sXG4gICAgYm9keTogc3RyZWFtLlJlYWRhYmxlIHwgQmluYXJ5LFxuICAgIHNoYTI1NnN1bTogc3RyaW5nLFxuICAgIHN0YXR1c0NvZGVzOiBudW1iZXJbXSxcbiAgICByZWdpb246IHN0cmluZyxcbiAgKTogUHJvbWlzZTxodHRwLkluY29taW5nTWVzc2FnZT4ge1xuICAgIGlmICghaXNPYmplY3Qob3B0aW9ucykpIHtcbiAgICAgIHRocm93IG5ldyBUeXBlRXJyb3IoJ29wdGlvbnMgc2hvdWxkIGJlIG9mIHR5cGUgXCJvYmplY3RcIicpXG4gICAgfVxuICAgIGlmICghKEJ1ZmZlci5pc0J1ZmZlcihib2R5KSB8fCB0eXBlb2YgYm9keSA9PT0gJ3N0cmluZycgfHwgaXNSZWFkYWJsZVN0cmVhbShib2R5KSkpIHtcbiAgICAgIHRocm93IG5ldyBlcnJvcnMuSW52YWxpZEFyZ3VtZW50RXJyb3IoXG4gICAgICAgIGBzdHJlYW0gc2hvdWxkIGJlIGEgQnVmZmVyLCBzdHJpbmcgb3IgcmVhZGFibGUgU3RyZWFtLCBnb3QgJHt0eXBlb2YgYm9keX0gaW5zdGVhZGAsXG4gICAgICApXG4gICAgfVxuICAgIGlmICghaXNTdHJpbmcoc2hhMjU2c3VtKSkge1xuICAgICAgdGhyb3cgbmV3IFR5cGVFcnJvcignc2hhMjU2c3VtIHNob3VsZCBiZSBvZiB0eXBlIFwic3RyaW5nXCInKVxuICAgIH1cbiAgICBzdGF0dXNDb2Rlcy5mb3JFYWNoKChzdGF0dXNDb2RlKSA9PiB7XG4gICAgICBpZiAoIWlzTnVtYmVyKHN0YXR1c0NvZGUpKSB7XG4gICAgICAgIHRocm93IG5ldyBUeXBlRXJyb3IoJ3N0YXR1c0NvZGUgc2hvdWxkIGJlIG9mIHR5cGUgXCJudW1iZXJcIicpXG4gICAgICB9XG4gICAgfSlcbiAgICBpZiAoIWlzU3RyaW5nKHJlZ2lvbikpIHtcbiAgICAgIHRocm93IG5ldyBUeXBlRXJyb3IoJ3JlZ2lvbiBzaG91bGQgYmUgb2YgdHlwZSBcInN0cmluZ1wiJylcbiAgICB9XG4gICAgLy8gc2hhMjU2c3VtIHdpbGwgYmUgZW1wdHkgZm9yIGFub255bW91cyBvciBodHRwcyByZXF1ZXN0c1xuICAgIGlmICghdGhpcy5lbmFibGVTSEEyNTYgJiYgc2hhMjU2c3VtLmxlbmd0aCAhPT0gMCkge1xuICAgICAgdGhyb3cgbmV3IGVycm9ycy5JbnZhbGlkQXJndW1lbnRFcnJvcihgc2hhMjU2c3VtIGV4cGVjdGVkIHRvIGJlIGVtcHR5IGZvciBhbm9ueW1vdXMgb3IgaHR0cHMgcmVxdWVzdHNgKVxuICAgIH1cbiAgICAvLyBzaGEyNTZzdW0gc2hvdWxkIGJlIHZhbGlkIGZvciBub24tYW5vbnltb3VzIGh0dHAgcmVxdWVzdHMuXG4gICAgaWYgKHRoaXMuZW5hYmxlU0hBMjU2ICYmIHNoYTI1NnN1bS5sZW5ndGggIT09IDY0KSB7XG4gICAgICB0aHJvdyBuZXcgZXJyb3JzLkludmFsaWRBcmd1bWVudEVycm9yKGBJbnZhbGlkIHNoYTI1NnN1bSA6ICR7c2hhMjU2c3VtfWApXG4gICAgfVxuXG4gICAgYXdhaXQgdGhpcy5jaGVja0FuZFJlZnJlc2hDcmVkcygpXG5cbiAgICAvLyBlc2xpbnQtZGlzYWJsZS1uZXh0LWxpbmUgQHR5cGVzY3JpcHQtZXNsaW50L25vLW5vbi1udWxsLWFzc2VydGlvblxuICAgIHJlZ2lvbiA9IHJlZ2lvbiB8fCAoYXdhaXQgdGhpcy5nZXRCdWNrZXRSZWdpb25Bc3luYyhvcHRpb25zLmJ1Y2tldE5hbWUhKSlcblxuICAgIGNvbnN0IHJlcU9wdGlvbnMgPSB0aGlzLmdldFJlcXVlc3RPcHRpb25zKHsgLi4ub3B0aW9ucywgcmVnaW9uIH0pXG4gICAgaWYgKCF0aGlzLmFub255bW91cykge1xuICAgICAgLy8gRm9yIG5vbi1hbm9ueW1vdXMgaHR0cHMgcmVxdWVzdHMgc2hhMjU2c3VtIGlzICdVTlNJR05FRC1QQVlMT0FEJyBmb3Igc2lnbmF0dXJlIGNhbGN1bGF0aW9uLlxuICAgICAgaWYgKCF0aGlzLmVuYWJsZVNIQTI1Nikge1xuICAgICAgICBzaGEyNTZzdW0gPSAnVU5TSUdORUQtUEFZTE9BRCdcbiAgICAgIH1cbiAgICAgIGNvbnN0IGRhdGUgPSBuZXcgRGF0ZSgpXG4gICAgICByZXFPcHRpb25zLmhlYWRlcnNbJ3gtYW16LWRhdGUnXSA9IG1ha2VEYXRlTG9uZyhkYXRlKVxuICAgICAgcmVxT3B0aW9ucy5oZWFkZXJzWyd4LWFtei1jb250ZW50LXNoYTI1NiddID0gc2hhMjU2c3VtXG4gICAgICBpZiAodGhpcy5zZXNzaW9uVG9rZW4pIHtcbiAgICAgICAgcmVxT3B0aW9ucy5oZWFkZXJzWyd4LWFtei1zZWN1cml0eS10b2tlbiddID0gdGhpcy5zZXNzaW9uVG9rZW5cbiAgICAgIH1cbiAgICAgIHJlcU9wdGlvbnMuaGVhZGVycy5hdXRob3JpemF0aW9uID0gc2lnblY0KHJlcU9wdGlvbnMsIHRoaXMuYWNjZXNzS2V5LCB0aGlzLnNlY3JldEtleSwgcmVnaW9uLCBkYXRlLCBzaGEyNTZzdW0pXG4gICAgfVxuXG4gICAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCByZXF1ZXN0V2l0aFJldHJ5KHRoaXMudHJhbnNwb3J0LCByZXFPcHRpb25zLCBib2R5KVxuICAgIGlmICghcmVzcG9uc2Uuc3RhdHVzQ29kZSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFwiQlVHOiByZXNwb25zZSBkb2Vzbid0IGhhdmUgYSBzdGF0dXNDb2RlXCIpXG4gICAgfVxuXG4gICAgaWYgKCFzdGF0dXNDb2Rlcy5pbmNsdWRlcyhyZXNwb25zZS5zdGF0dXNDb2RlKSkge1xuICAgICAgLy8gRm9yIGFuIGluY29ycmVjdCByZWdpb24sIFMzIHNlcnZlciBhbHdheXMgc2VuZHMgYmFjayA0MDAuXG4gICAgICAvLyBCdXQgd2Ugd2lsbCBkbyBjYWNoZSBpbnZhbGlkYXRpb24gZm9yIGFsbCBlcnJvcnMgc28gdGhhdCxcbiAgICAgIC8vIGluIGZ1dHVyZSwgaWYgQVdTIFMzIGRlY2lkZXMgdG8gc2VuZCBhIGRpZmZlcmVudCBzdGF0dXMgY29kZSBvclxuICAgICAgLy8gWE1MIGVycm9yIGNvZGUgd2Ugd2lsbCBzdGlsbCB3b3JrIGZpbmUuXG4gICAgICAvLyBlc2xpbnQtZGlzYWJsZS1uZXh0LWxpbmUgQHR5cGVzY3JpcHQtZXNsaW50L25vLW5vbi1udWxsLWFzc2VydGlvblxuICAgICAgZGVsZXRlIHRoaXMucmVnaW9uTWFwW29wdGlvbnMuYnVja2V0TmFtZSFdXG5cbiAgICAgIGNvbnN0IGVyciA9IGF3YWl0IHhtbFBhcnNlcnMucGFyc2VSZXNwb25zZUVycm9yKHJlc3BvbnNlKVxuICAgICAgdGhpcy5sb2dIVFRQKHJlcU9wdGlvbnMsIHJlc3BvbnNlLCBlcnIpXG4gICAgICB0aHJvdyBlcnJcbiAgICB9XG5cbiAgICB0aGlzLmxvZ0hUVFAocmVxT3B0aW9ucywgcmVzcG9uc2UpXG5cbiAgICByZXR1cm4gcmVzcG9uc2VcbiAgfVxuXG4gIC8qKlxuICAgKiBnZXRzIHRoZSByZWdpb24gb2YgdGhlIGJ1Y2tldFxuICAgKlxuICAgKiBAcGFyYW0gYnVja2V0TmFtZVxuICAgKlxuICAgKi9cbiAgYXN5bmMgZ2V0QnVja2V0UmVnaW9uQXN5bmMoYnVja2V0TmFtZTogc3RyaW5nKTogUHJvbWlzZTxzdHJpbmc+IHtcbiAgICBpZiAoIWlzVmFsaWRCdWNrZXROYW1lKGJ1Y2tldE5hbWUpKSB7XG4gICAgICB0aHJvdyBuZXcgZXJyb3JzLkludmFsaWRCdWNrZXROYW1lRXJyb3IoYEludmFsaWQgYnVja2V0IG5hbWUgOiAke2J1Y2tldE5hbWV9YClcbiAgICB9XG5cbiAgICAvLyBSZWdpb24gaXMgc2V0IHdpdGggY29uc3RydWN0b3IsIHJldHVybiB0aGUgcmVnaW9uIHJpZ2h0IGhlcmUuXG4gICAgaWYgKHRoaXMucmVnaW9uKSB7XG4gICAgICByZXR1cm4gdGhpcy5yZWdpb25cbiAgICB9XG5cbiAgICBjb25zdCBjYWNoZWQgPSB0aGlzLnJlZ2lvbk1hcFtidWNrZXROYW1lXVxuICAgIGlmIChjYWNoZWQpIHtcbiAgICAgIHJldHVybiBjYWNoZWRcbiAgICB9XG5cbiAgICBjb25zdCBleHRyYWN0UmVnaW9uQXN5bmMgPSBhc3luYyAocmVzcG9uc2U6IGh0dHAuSW5jb21pbmdNZXNzYWdlKSA9PiB7XG4gICAgICBjb25zdCBib2R5ID0gYXdhaXQgcmVhZEFzU3RyaW5nKHJlc3BvbnNlKVxuICAgICAgY29uc3QgcmVnaW9uID0geG1sUGFyc2Vycy5wYXJzZUJ1Y2tldFJlZ2lvbihib2R5KSB8fCBERUZBVUxUX1JFR0lPTlxuICAgICAgdGhpcy5yZWdpb25NYXBbYnVja2V0TmFtZV0gPSByZWdpb25cbiAgICAgIHJldHVybiByZWdpb25cbiAgICB9XG5cbiAgICBjb25zdCBtZXRob2QgPSAnR0VUJ1xuICAgIGNvbnN0IHF1ZXJ5ID0gJ2xvY2F0aW9uJ1xuICAgIC8vIGBnZXRCdWNrZXRMb2NhdGlvbmAgYmVoYXZlcyBkaWZmZXJlbnRseSBpbiBmb2xsb3dpbmcgd2F5cyBmb3JcbiAgICAvLyBkaWZmZXJlbnQgZW52aXJvbm1lbnRzLlxuICAgIC8vXG4gICAgLy8gLSBGb3Igbm9kZWpzIGVudiB3ZSBkZWZhdWx0IHRvIHBhdGggc3R5bGUgcmVxdWVzdHMuXG4gICAgLy8gLSBGb3IgYnJvd3NlciBlbnYgcGF0aCBzdHlsZSByZXF1ZXN0cyBvbiBidWNrZXRzIHlpZWxkcyBDT1JTXG4gICAgLy8gICBlcnJvci4gVG8gY2lyY3VtdmVudCB0aGlzIHByb2JsZW0gd2UgbWFrZSBhIHZpcnR1YWwgaG9zdFxuICAgIC8vICAgc3R5bGUgcmVxdWVzdCBzaWduZWQgd2l0aCAndXMtZWFzdC0xJy4gVGhpcyByZXF1ZXN0IGZhaWxzXG4gICAgLy8gICB3aXRoIGFuIGVycm9yICdBdXRob3JpemF0aW9uSGVhZGVyTWFsZm9ybWVkJywgYWRkaXRpb25hbGx5XG4gICAgLy8gICB0aGUgZXJyb3IgWE1MIGFsc28gcHJvdmlkZXMgUmVnaW9uIG9mIHRoZSBidWNrZXQuIFRvIHZhbGlkYXRlXG4gICAgLy8gICB0aGlzIHJlZ2lvbiBpcyBwcm9wZXIgd2UgcmV0cnkgdGhlIHNhbWUgcmVxdWVzdCB3aXRoIHRoZSBuZXdseVxuICAgIC8vICAgb2J0YWluZWQgcmVnaW9uLlxuICAgIGNvbnN0IHBhdGhTdHlsZSA9IHRoaXMucGF0aFN0eWxlICYmICFpc0Jyb3dzZXJcbiAgICBsZXQgcmVnaW9uOiBzdHJpbmdcbiAgICB0cnkge1xuICAgICAgY29uc3QgcmVzID0gYXdhaXQgdGhpcy5tYWtlUmVxdWVzdEFzeW5jKHsgbWV0aG9kLCBidWNrZXROYW1lLCBxdWVyeSwgcGF0aFN0eWxlIH0sICcnLCBbMjAwXSwgREVGQVVMVF9SRUdJT04pXG4gICAgICByZXR1cm4gZXh0cmFjdFJlZ2lvbkFzeW5jKHJlcylcbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICAvLyBtYWtlIGFsaWdubWVudCB3aXRoIG1jIGNsaVxuICAgICAgaWYgKGUgaW5zdGFuY2VvZiBlcnJvcnMuUzNFcnJvcikge1xuICAgICAgICBjb25zdCBlcnJDb2RlID0gZS5jb2RlXG4gICAgICAgIGNvbnN0IGVyclJlZ2lvbiA9IGUucmVnaW9uXG4gICAgICAgIGlmIChlcnJDb2RlID09PSAnQWNjZXNzRGVuaWVkJyAmJiAhZXJyUmVnaW9uKSB7XG4gICAgICAgICAgcmV0dXJuIERFRkFVTFRfUkVHSU9OXG4gICAgICAgIH1cbiAgICAgIH1cbiAgICAgIC8vIGVzbGludC1kaXNhYmxlLW5leHQtbGluZSBAdHlwZXNjcmlwdC1lc2xpbnQvYmFuLXRzLWNvbW1lbnRcbiAgICAgIC8vIEB0cy1pZ25vcmVcbiAgICAgIGlmICghKGUubmFtZSA9PT0gJ0F1dGhvcml6YXRpb25IZWFkZXJNYWxmb3JtZWQnKSkge1xuICAgICAgICB0aHJvdyBlXG4gICAgICB9XG4gICAgICAvLyBAdHMtZXhwZWN0LWVycm9yIHdlIHNldCBleHRyYSBwcm9wZXJ0aWVzIG9uIGVycm9yIG9iamVjdFxuICAgICAgcmVnaW9uID0gZS5SZWdpb24gYXMgc3RyaW5nXG4gICAgICBpZiAoIXJlZ2lvbikge1xuICAgICAgICB0aHJvdyBlXG4gICAgICB9XG4gICAgfVxuXG4gICAgY29uc3QgcmVzID0gYXdhaXQgdGhpcy5tYWtlUmVxdWVzdEFzeW5jKHsgbWV0aG9kLCBidWNrZXROYW1lLCBxdWVyeSwgcGF0aFN0eWxlIH0sICcnLCBbMjAwXSwgcmVnaW9uKVxuICAgIHJldHVybiBhd2FpdCBleHRyYWN0UmVnaW9uQXN5bmMocmVzKVxuICB9XG5cbiAgLyoqXG4gICAqIG1ha2VSZXF1ZXN0IGlzIHRoZSBwcmltaXRpdmUgdXNlZCBieSB0aGUgYXBpcyBmb3IgbWFraW5nIFMzIHJlcXVlc3RzLlxuICAgKiBwYXlsb2FkIGNhbiBiZSBlbXB0eSBzdHJpbmcgaW4gY2FzZSBvZiBubyBwYXlsb2FkLlxuICAgKiBzdGF0dXNDb2RlIGlzIHRoZSBleHBlY3RlZCBzdGF0dXNDb2RlLiBJZiByZXNwb25zZS5zdGF0dXNDb2RlIGRvZXMgbm90IG1hdGNoXG4gICAqIHdlIHBhcnNlIHRoZSBYTUwgZXJyb3IgYW5kIGNhbGwgdGhlIGNhbGxiYWNrIHdpdGggdGhlIGVycm9yIG1lc3NhZ2UuXG4gICAqIEEgdmFsaWQgcmVnaW9uIGlzIHBhc3NlZCBieSB0aGUgY2FsbHMgLSBsaXN0QnVja2V0cywgbWFrZUJ1Y2tldCBhbmRcbiAgICogZ2V0QnVja2V0UmVnaW9uLlxuICAgKlxuICAgKiBAZGVwcmVjYXRlZCB1c2UgYG1ha2VSZXF1ZXN0QXN5bmNgIGluc3RlYWRcbiAgICovXG4gIG1ha2VSZXF1ZXN0KFxuICAgIG9wdGlvbnM6IFJlcXVlc3RPcHRpb24sXG4gICAgcGF5bG9hZDogQmluYXJ5ID0gJycsXG4gICAgZXhwZWN0ZWRDb2RlczogbnVtYmVyW10gPSBbMjAwXSxcbiAgICByZWdpb24gPSAnJyxcbiAgICByZXR1cm5SZXNwb25zZTogYm9vbGVhbixcbiAgICBjYjogKGNiOiB1bmtub3duLCByZXN1bHQ6IGh0dHAuSW5jb21pbmdNZXNzYWdlKSA9PiB2b2lkLFxuICApIHtcbiAgICBsZXQgcHJvbTogUHJvbWlzZTxodHRwLkluY29taW5nTWVzc2FnZT5cbiAgICBpZiAocmV0dXJuUmVzcG9uc2UpIHtcbiAgICAgIHByb20gPSB0aGlzLm1ha2VSZXF1ZXN0QXN5bmMob3B0aW9ucywgcGF5bG9hZCwgZXhwZWN0ZWRDb2RlcywgcmVnaW9uKVxuICAgIH0gZWxzZSB7XG4gICAgICAvLyBlc2xpbnQtZGlzYWJsZS1uZXh0LWxpbmUgQHR5cGVzY3JpcHQtZXNsaW50L2Jhbi10cy1jb21tZW50XG4gICAgICAvLyBAdHMtZXhwZWN0LWVycm9yIGNvbXBhdGlibGUgZm9yIG9sZCBiZWhhdmlvdXJcbiAgICAgIHByb20gPSB0aGlzLm1ha2VSZXF1ZXN0QXN5bmNPbWl0KG9wdGlvbnMsIHBheWxvYWQsIGV4cGVjdGVkQ29kZXMsIHJlZ2lvbilcbiAgICB9XG5cbiAgICBwcm9tLnRoZW4oXG4gICAgICAocmVzdWx0KSA9PiBjYihudWxsLCByZXN1bHQpLFxuICAgICAgKGVycikgPT4ge1xuICAgICAgICAvLyBlc2xpbnQtZGlzYWJsZS1uZXh0LWxpbmUgQHR5cGVzY3JpcHQtZXNsaW50L2Jhbi10cy1jb21tZW50XG4gICAgICAgIC8vIEB0cy1pZ25vcmVcbiAgICAgICAgY2IoZXJyKVxuICAgICAgfSxcbiAgICApXG4gIH1cblxuICAvKipcbiAgICogbWFrZVJlcXVlc3RTdHJlYW0gd2lsbCBiZSB1c2VkIGRpcmVjdGx5IGluc3RlYWQgb2YgbWFrZVJlcXVlc3QgaW4gY2FzZSB0aGUgcGF5bG9hZFxuICAgKiBpcyBhdmFpbGFibGUgYXMgYSBzdHJlYW0uIGZvciBleC4gcHV0T2JqZWN0XG4gICAqXG4gICAqIEBkZXByZWNhdGVkIHVzZSBgbWFrZVJlcXVlc3RTdHJlYW1Bc3luY2AgaW5zdGVhZFxuICAgKi9cbiAgbWFrZVJlcXVlc3RTdHJlYW0oXG4gICAgb3B0aW9uczogUmVxdWVzdE9wdGlvbixcbiAgICBzdHJlYW06IHN0cmVhbS5SZWFkYWJsZSB8IEJ1ZmZlcixcbiAgICBzaGEyNTZzdW06IHN0cmluZyxcbiAgICBzdGF0dXNDb2RlczogbnVtYmVyW10sXG4gICAgcmVnaW9uOiBzdHJpbmcsXG4gICAgcmV0dXJuUmVzcG9uc2U6IGJvb2xlYW4sXG4gICAgY2I6IChjYjogdW5rbm93biwgcmVzdWx0OiBodHRwLkluY29taW5nTWVzc2FnZSkgPT4gdm9pZCxcbiAgKSB7XG4gICAgY29uc3QgZXhlY3V0b3IgPSBhc3luYyAoKSA9PiB7XG4gICAgICBjb25zdCByZXMgPSBhd2FpdCB0aGlzLm1ha2VSZXF1ZXN0U3RyZWFtQXN5bmMob3B0aW9ucywgc3RyZWFtLCBzaGEyNTZzdW0sIHN0YXR1c0NvZGVzLCByZWdpb24pXG4gICAgICBpZiAoIXJldHVyblJlc3BvbnNlKSB7XG4gICAgICAgIGF3YWl0IGRyYWluUmVzcG9uc2UocmVzKVxuICAgICAgfVxuXG4gICAgICByZXR1cm4gcmVzXG4gICAgfVxuXG4gICAgZXhlY3V0b3IoKS50aGVuKFxuICAgICAgKHJlc3VsdCkgPT4gY2IobnVsbCwgcmVzdWx0KSxcbiAgICAgIC8vIGVzbGludC1kaXNhYmxlLW5leHQtbGluZSBAdHlwZXNjcmlwdC1lc2xpbnQvYmFuLXRzLWNvbW1lbnRcbiAgICAgIC8vIEB0cy1pZ25vcmVcbiAgICAgIChlcnIpID0+IGNiKGVyciksXG4gICAgKVxuICB9XG5cbiAgLyoqXG4gICAqIEBkZXByZWNhdGVkIHVzZSBgZ2V0QnVja2V0UmVnaW9uQXN5bmNgIGluc3RlYWRcbiAgICovXG4gIGdldEJ1Y2tldFJlZ2lvbihidWNrZXROYW1lOiBzdHJpbmcsIGNiOiAoZXJyOiB1bmtub3duLCByZWdpb246IHN0cmluZykgPT4gdm9pZCkge1xuICAgIHJldHVybiB0aGlzLmdldEJ1Y2tldFJlZ2lvbkFzeW5jKGJ1Y2tldE5hbWUpLnRoZW4oXG4gICAgICAocmVzdWx0KSA9PiBjYihudWxsLCByZXN1bHQpLFxuICAgICAgLy8gZXNsaW50LWRpc2FibGUtbmV4dC1saW5lIEB0eXBlc2NyaXB0LWVzbGludC9iYW4tdHMtY29tbWVudFxuICAgICAgLy8gQHRzLWlnbm9yZVxuICAgICAgKGVycikgPT4gY2IoZXJyKSxcbiAgICApXG4gIH1cblxuICAvLyBCdWNrZXQgb3BlcmF0aW9uc1xuXG4gIC8qKlxuICAgKiBDcmVhdGVzIHRoZSBidWNrZXQgYGJ1Y2tldE5hbWVgLlxuICAgKlxuICAgKi9cbiAgYXN5bmMgbWFrZUJ1Y2tldChidWNrZXROYW1lOiBzdHJpbmcsIHJlZ2lvbjogUmVnaW9uID0gJycsIG1ha2VPcHRzPzogTWFrZUJ1Y2tldE9wdCk6IFByb21pc2U8dm9pZD4ge1xuICAgIGlmICghaXNWYWxpZEJ1Y2tldE5hbWUoYnVja2V0TmFtZSkpIHtcbiAgICAgIHRocm93IG5ldyBlcnJvcnMuSW52YWxpZEJ1Y2tldE5hbWVFcnJvcignSW52YWxpZCBidWNrZXQgbmFtZTogJyArIGJ1Y2tldE5hbWUpXG4gICAgfVxuICAgIC8vIEJhY2t3YXJkIENvbXBhdGliaWxpdHlcbiAgICBpZiAoaXNPYmplY3QocmVnaW9uKSkge1xuICAgICAgbWFrZU9wdHMgPSByZWdpb25cbiAgICAgIHJlZ2lvbiA9ICcnXG4gICAgfVxuXG4gICAgaWYgKCFpc1N0cmluZyhyZWdpb24pKSB7XG4gICAgICB0aHJvdyBuZXcgVHlwZUVycm9yKCdyZWdpb24gc2hvdWxkIGJlIG9mIHR5cGUgXCJzdHJpbmdcIicpXG4gICAgfVxuICAgIGlmIChtYWtlT3B0cyAmJiAhaXNPYmplY3QobWFrZU9wdHMpKSB7XG4gICAgICB0aHJvdyBuZXcgVHlwZUVycm9yKCdtYWtlT3B0cyBzaG91bGQgYmUgb2YgdHlwZSBcIm9iamVjdFwiJylcbiAgICB9XG5cbiAgICBsZXQgcGF5bG9hZCA9ICcnXG5cbiAgICAvLyBSZWdpb24gYWxyZWFkeSBzZXQgaW4gY29uc3RydWN0b3IsIHZhbGlkYXRlIGlmXG4gICAgLy8gY2FsbGVyIHJlcXVlc3RlZCBidWNrZXQgbG9jYXRpb24gaXMgc2FtZS5cbiAgICBpZiAocmVnaW9uICYmIHRoaXMucmVnaW9uKSB7XG4gICAgICBpZiAocmVnaW9uICE9PSB0aGlzLnJlZ2lvbikge1xuICAgICAgICB0aHJvdyBuZXcgZXJyb3JzLkludmFsaWRBcmd1bWVudEVycm9yKGBDb25maWd1cmVkIHJlZ2lvbiAke3RoaXMucmVnaW9ufSwgcmVxdWVzdGVkICR7cmVnaW9ufWApXG4gICAgICB9XG4gICAgfVxuICAgIC8vIHNlbmRpbmcgbWFrZUJ1Y2tldCByZXF1ZXN0IHdpdGggWE1MIGNvbnRhaW5pbmcgJ3VzLWVhc3QtMScgZmFpbHMuIEZvclxuICAgIC8vIGRlZmF1bHQgcmVnaW9uIHNlcnZlciBleHBlY3RzIHRoZSByZXF1ZXN0IHdpdGhvdXQgYm9keVxuICAgIGlmIChyZWdpb24gJiYgcmVnaW9uICE9PSBERUZBVUxUX1JFR0lPTikge1xuICAgICAgcGF5bG9hZCA9IHhtbC5idWlsZE9iamVjdCh7XG4gICAgICAgIENyZWF0ZUJ1Y2tldENvbmZpZ3VyYXRpb246IHtcbiAgICAgICAgICAkOiB7IHhtbG5zOiAnaHR0cDovL3MzLmFtYXpvbmF3cy5jb20vZG9jLzIwMDYtMDMtMDEvJyB9LFxuICAgICAgICAgIExvY2F0aW9uQ29uc3RyYWludDogcmVnaW9uLFxuICAgICAgICB9LFxuICAgICAgfSlcbiAgICB9XG4gICAgY29uc3QgbWV0aG9kID0gJ1BVVCdcbiAgICBjb25zdCBoZWFkZXJzOiBSZXF1ZXN0SGVhZGVycyA9IHt9XG5cbiAgICBpZiAobWFrZU9wdHMgJiYgbWFrZU9wdHMuT2JqZWN0TG9ja2luZykge1xuICAgICAgaGVhZGVyc1sneC1hbXotYnVja2V0LW9iamVjdC1sb2NrLWVuYWJsZWQnXSA9IHRydWVcbiAgICB9XG5cbiAgICAvLyBGb3IgY3VzdG9tIHJlZ2lvbiBjbGllbnRzICBkZWZhdWx0IHRvIGN1c3RvbSByZWdpb24gc3BlY2lmaWVkIGluIGNsaWVudCBjb25zdHJ1Y3RvclxuICAgIGNvbnN0IGZpbmFsUmVnaW9uID0gdGhpcy5yZWdpb24gfHwgcmVnaW9uIHx8IERFRkFVTFRfUkVHSU9OXG5cbiAgICBjb25zdCByZXF1ZXN0T3B0OiBSZXF1ZXN0T3B0aW9uID0geyBtZXRob2QsIGJ1Y2tldE5hbWUsIGhlYWRlcnMgfVxuXG4gICAgdHJ5IHtcbiAgICAgIGF3YWl0IHRoaXMubWFrZVJlcXVlc3RBc3luY09taXQocmVxdWVzdE9wdCwgcGF5bG9hZCwgWzIwMF0sIGZpbmFsUmVnaW9uKVxuICAgIH0gY2F0Y2ggKGVycjogdW5rbm93bikge1xuICAgICAgaWYgKHJlZ2lvbiA9PT0gJycgfHwgcmVnaW9uID09PSBERUZBVUxUX1JFR0lPTikge1xuICAgICAgICBpZiAoZXJyIGluc3RhbmNlb2YgZXJyb3JzLlMzRXJyb3IpIHtcbiAgICAgICAgICBjb25zdCBlcnJDb2RlID0gZXJyLmNvZGVcbiAgICAgICAgICBjb25zdCBlcnJSZWdpb24gPSBlcnIucmVnaW9uXG4gICAgICAgICAgaWYgKGVyckNvZGUgPT09ICdBdXRob3JpemF0aW9uSGVhZGVyTWFsZm9ybWVkJyAmJiBlcnJSZWdpb24gIT09ICcnKSB7XG4gICAgICAgICAgICAvLyBSZXRyeSB3aXRoIHJlZ2lvbiByZXR1cm5lZCBhcyBwYXJ0IG9mIGVycm9yXG4gICAgICAgICAgICBhd2FpdCB0aGlzLm1ha2VSZXF1ZXN0QXN5bmNPbWl0KHJlcXVlc3RPcHQsIHBheWxvYWQsIFsyMDBdLCBlcnJDb2RlKVxuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgdGhyb3cgZXJyXG4gICAgfVxuICB9XG5cbiAgLyoqXG4gICAqIFRvIGNoZWNrIGlmIGEgYnVja2V0IGFscmVhZHkgZXhpc3RzLlxuICAgKi9cbiAgYXN5bmMgYnVja2V0RXhpc3RzKGJ1Y2tldE5hbWU6IHN0cmluZyk6IFByb21pc2U8Ym9vbGVhbj4ge1xuICAgIGlmICghaXNWYWxpZEJ1Y2tldE5hbWUoYnVja2V0TmFtZSkpIHtcbiAgICAgIHRocm93IG5ldyBlcnJvcnMuSW52YWxpZEJ1Y2tldE5hbWVFcnJvcignSW52YWxpZCBidWNrZXQgbmFtZTogJyArIGJ1Y2tldE5hbWUpXG4gICAgfVxuICAgIGNvbnN0IG1ldGhvZCA9ICdIRUFEJ1xuICAgIHRyeSB7XG4gICAgICBhd2FpdCB0aGlzLm1ha2VSZXF1ZXN0QXN5bmNPbWl0KHsgbWV0aG9kLCBidWNrZXROYW1lIH0pXG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAvLyBAdHMtaWdub3JlXG4gICAgICBpZiAoZXJyLmNvZGUgPT09ICdOb1N1Y2hCdWNrZXQnIHx8IGVyci5jb2RlID09PSAnTm90Rm91bmQnKSB7XG4gICAgICAgIHJldHVybiBmYWxzZVxuICAgICAgfVxuICAgICAgdGhyb3cgZXJyXG4gICAgfVxuXG4gICAgcmV0dXJuIHRydWVcbiAgfVxuXG4gIGFzeW5jIHJlbW92ZUJ1Y2tldChidWNrZXROYW1lOiBzdHJpbmcpOiBQcm9taXNlPHZvaWQ+XG5cbiAgLyoqXG4gICAqIEBkZXByZWNhdGVkIHVzZSBwcm9taXNlIHN0eWxlIEFQSVxuICAgKi9cbiAgcmVtb3ZlQnVja2V0KGJ1Y2tldE5hbWU6IHN0cmluZywgY2FsbGJhY2s6IE5vUmVzdWx0Q2FsbGJhY2spOiB2b2lkXG5cbiAgYXN5bmMgcmVtb3ZlQnVja2V0KGJ1Y2tldE5hbWU6IHN0cmluZyk6IFByb21pc2U8dm9pZD4ge1xuICAgIGlmICghaXNWYWxpZEJ1Y2tldE5hbWUoYnVja2V0TmFtZSkpIHtcbiAgICAgIHRocm93IG5ldyBlcnJvcnMuSW52YWxpZEJ1Y2tldE5hbWVFcnJvcignSW52YWxpZCBidWNrZXQgbmFtZTogJyArIGJ1Y2tldE5hbWUpXG4gICAgfVxuICAgIGNvbnN0IG1ldGhvZCA9ICdERUxFVEUnXG4gICAgYXdhaXQgdGhpcy5tYWtlUmVxdWVzdEFzeW5jT21pdCh7IG1ldGhvZCwgYnVja2V0TmFtZSB9LCAnJywgWzIwNF0pXG4gICAgZGVsZXRlIHRoaXMucmVnaW9uTWFwW2J1Y2tldE5hbWVdXG4gIH1cblxuICAvKipcbiAgICogQ2FsbGJhY2sgaXMgY2FsbGVkIHdpdGggcmVhZGFibGUgc3RyZWFtIG9mIHRoZSBvYmplY3QgY29udGVudC5cbiAgICovXG4gIGFzeW5jIGdldE9iamVjdChidWNrZXROYW1lOiBzdHJpbmcsIG9iamVjdE5hbWU6IHN0cmluZywgZ2V0T3B0cz86IEdldE9iamVjdE9wdHMpOiBQcm9taXNlPHN0cmVhbS5SZWFkYWJsZT4ge1xuICAgIGlmICghaXNWYWxpZEJ1Y2tldE5hbWUoYnVja2V0TmFtZSkpIHtcbiAgICAgIHRocm93IG5ldyBlcnJvcnMuSW52YWxpZEJ1Y2tldE5hbWVFcnJvcignSW52YWxpZCBidWNrZXQgbmFtZTogJyArIGJ1Y2tldE5hbWUpXG4gICAgfVxuICAgIGlmICghaXNWYWxpZE9iamVjdE5hbWUob2JqZWN0TmFtZSkpIHtcbiAgICAgIHRocm93IG5ldyBlcnJvcnMuSW52YWxpZE9iamVjdE5hbWVFcnJvcihgSW52YWxpZCBvYmplY3QgbmFtZTogJHtvYmplY3ROYW1lfWApXG4gICAgfVxuICAgIHJldHVybiB0aGlzLmdldFBhcnRpYWxPYmplY3QoYnVja2V0TmFtZSwgb2JqZWN0TmFtZSwgMCwgMCwgZ2V0T3B0cylcbiAgfVxuXG4gIC8qKlxuICAgKiBDYWxsYmFjayBpcyBjYWxsZWQgd2l0aCByZWFkYWJsZSBzdHJlYW0gb2YgdGhlIHBhcnRpYWwgb2JqZWN0IGNvbnRlbnQuXG4gICAqIEBwYXJhbSBidWNrZXROYW1lXG4gICAqIEBwYXJhbSBvYmplY3ROYW1lXG4gICAqIEBwYXJhbSBvZmZzZXRcbiAgICogQHBhcmFtIGxlbmd0aCAtIGxlbmd0aCBvZiB0aGUgb2JqZWN0IHRoYXQgd2lsbCBiZSByZWFkIGluIHRoZSBzdHJlYW0gKG9wdGlvbmFsLCBpZiBub3Qgc3BlY2lmaWVkIHdlIHJlYWQgdGhlIHJlc3Qgb2YgdGhlIGZpbGUgZnJvbSB0aGUgb2Zmc2V0KVxuICAgKiBAcGFyYW0gZ2V0T3B0c1xuICAgKi9cbiAgYXN5bmMgZ2V0UGFydGlhbE9iamVjdChcbiAgICBidWNrZXROYW1lOiBzdHJpbmcsXG4gICAgb2JqZWN0TmFtZTogc3RyaW5nLFxuICAgIG9mZnNldDogbnVtYmVyLFxuICAgIGxlbmd0aCA9IDAsXG4gICAgZ2V0T3B0cz86IEdldE9iamVjdE9wdHMsXG4gICk6IFByb21pc2U8c3RyZWFtLlJlYWRhYmxlPiB7XG4gICAgaWYgKCFpc1ZhbGlkQnVja2V0TmFtZShidWNrZXROYW1lKSkge1xuICAgICAgdGhyb3cgbmV3IGVycm9ycy5JbnZhbGlkQnVja2V0TmFtZUVycm9yKCdJbnZhbGlkIGJ1Y2tldCBuYW1lOiAnICsgYnVja2V0TmFtZSlcbiAgICB9XG4gICAgaWYgKCFpc1ZhbGlkT2JqZWN0TmFtZShvYmplY3ROYW1lKSkge1xuICAgICAgdGhyb3cgbmV3IGVycm9ycy5JbnZhbGlkT2JqZWN0TmFtZUVycm9yKGBJbnZhbGlkIG9iamVjdCBuYW1lOiAke29iamVjdE5hbWV9YClcbiAgICB9XG4gICAgaWYgKCFpc051bWJlcihvZmZzZXQpKSB7XG4gICAgICB0aHJvdyBuZXcgVHlwZUVycm9yKCdvZmZzZXQgc2hvdWxkIGJlIG9mIHR5cGUgXCJudW1iZXJcIicpXG4gICAgfVxuICAgIGlmICghaXNOdW1iZXIobGVuZ3RoKSkge1xuICAgICAgdGhyb3cgbmV3IFR5cGVFcnJvcignbGVuZ3RoIHNob3VsZCBiZSBvZiB0eXBlIFwibnVtYmVyXCInKVxuICAgIH1cblxuICAgIGxldCByYW5nZSA9ICcnXG4gICAgaWYgKG9mZnNldCB8fCBsZW5ndGgpIHtcbiAgICAgIGlmIChvZmZzZXQpIHtcbiAgICAgICAgcmFuZ2UgPSBgYnl0ZXM9JHsrb2Zmc2V0fS1gXG4gICAgICB9IGVsc2Uge1xuICAgICAgICByYW5nZSA9ICdieXRlcz0wLSdcbiAgICAgICAgb2Zmc2V0ID0gMFxuICAgICAgfVxuICAgICAgaWYgKGxlbmd0aCkge1xuICAgICAgICByYW5nZSArPSBgJHsrbGVuZ3RoICsgb2Zmc2V0IC0gMX1gXG4gICAgICB9XG4gICAgfVxuXG4gICAgbGV0IHF1ZXJ5ID0gJydcbiAgICBsZXQgaGVhZGVyczogUmVxdWVzdEhlYWRlcnMgPSB7XG4gICAgICAuLi4ocmFuZ2UgIT09ICcnICYmIHsgcmFuZ2UgfSksXG4gICAgfVxuXG4gICAgaWYgKGdldE9wdHMpIHtcbiAgICAgIGNvbnN0IHNzZUhlYWRlcnM6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7XG4gICAgICAgIC4uLihnZXRPcHRzLlNTRUN1c3RvbWVyQWxnb3JpdGhtICYmIHtcbiAgICAgICAgICAnWC1BbXotU2VydmVyLVNpZGUtRW5jcnlwdGlvbi1DdXN0b21lci1BbGdvcml0aG0nOiBnZXRPcHRzLlNTRUN1c3RvbWVyQWxnb3JpdGhtLFxuICAgICAgICB9KSxcbiAgICAgICAgLi4uKGdldE9wdHMuU1NFQ3VzdG9tZXJLZXkgJiYgeyAnWC1BbXotU2VydmVyLVNpZGUtRW5jcnlwdGlvbi1DdXN0b21lci1LZXknOiBnZXRPcHRzLlNTRUN1c3RvbWVyS2V5IH0pLFxuICAgICAgICAuLi4oZ2V0T3B0cy5TU0VDdXN0b21lcktleU1ENSAmJiB7XG4gICAgICAgICAgJ1gtQW16LVNlcnZlci1TaWRlLUVuY3J5cHRpb24tQ3VzdG9tZXItS2V5LU1ENSc6IGdldE9wdHMuU1NFQ3VzdG9tZXJLZXlNRDUsXG4gICAgICAgIH0pLFxuICAgICAgfVxuICAgICAgcXVlcnkgPSBxcy5zdHJpbmdpZnkoZ2V0T3B0cylcbiAgICAgIGhlYWRlcnMgPSB7XG4gICAgICAgIC4uLnByZXBlbmRYQU1aTWV0YShzc2VIZWFkZXJzKSxcbiAgICAgICAgLi4uaGVhZGVycyxcbiAgICAgIH1cbiAgICB9XG5cbiAgICBjb25zdCBleHBlY3RlZFN0YXR1c0NvZGVzID0gWzIwMF1cbiAgICBpZiAocmFuZ2UpIHtcbiAgICAgIGV4cGVjdGVkU3RhdHVzQ29kZXMucHVzaCgyMDYpXG4gICAgfVxuICAgIGNvbnN0IG1ldGhvZCA9ICdHRVQnXG5cbiAgICByZXR1cm4gYXdhaXQgdGhpcy5tYWtlUmVxdWVzdEFzeW5jKHsgbWV0aG9kLCBidWNrZXROYW1lLCBvYmplY3ROYW1lLCBoZWFkZXJzLCBxdWVyeSB9LCAnJywgZXhwZWN0ZWRTdGF0dXNDb2RlcylcbiAgfVxuXG4gIC8qKlxuICAgKiBkb3dubG9hZCBvYmplY3QgY29udGVudCB0byBhIGZpbGUuXG4gICAqIFRoaXMgbWV0aG9kIHdpbGwgY3JlYXRlIGEgdGVtcCBmaWxlIG5hbWVkIGAke2ZpbGVuYW1lfS4ke2Jhc2U2NChldGFnKX0ucGFydC5taW5pb2Agd2hlbiBkb3dubG9hZGluZy5cbiAgICpcbiAgICogQHBhcmFtIGJ1Y2tldE5hbWUgLSBuYW1lIG9mIHRoZSBidWNrZXRcbiAgICogQHBhcmFtIG9iamVjdE5hbWUgLSBuYW1lIG9mIHRoZSBvYmplY3RcbiAgICogQHBhcmFtIGZpbGVQYXRoIC0gcGF0aCB0byB3aGljaCB0aGUgb2JqZWN0IGRhdGEgd2lsbCBiZSB3cml0dGVuIHRvXG4gICAqIEBwYXJhbSBnZXRPcHRzIC0gT3B0aW9uYWwgb2JqZWN0IGdldCBvcHRpb25cbiAgICovXG4gIGFzeW5jIGZHZXRPYmplY3QoYnVja2V0TmFtZTogc3RyaW5nLCBvYmplY3ROYW1lOiBzdHJpbmcsIGZpbGVQYXRoOiBzdHJpbmcsIGdldE9wdHM/OiBHZXRPYmplY3RPcHRzKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgLy8gSW5wdXQgdmFsaWRhdGlvbi5cbiAgICBpZiAoIWlzVmFsaWRCdWNrZXROYW1lKGJ1Y2tldE5hbWUpKSB7XG4gICAgICB0aHJvdyBuZXcgZXJyb3JzLkludmFsaWRCdWNrZXROYW1lRXJyb3IoJ0ludmFsaWQgYnVja2V0IG5hbWU6ICcgKyBidWNrZXROYW1lKVxuICAgIH1cbiAgICBpZiAoIWlzVmFsaWRPYmplY3ROYW1lKG9iamVjdE5hbWUpKSB7XG4gICAgICB0aHJvdyBuZXcgZXJyb3JzLkludmFsaWRPYmplY3ROYW1lRXJyb3IoYEludmFsaWQgb2JqZWN0IG5hbWU6ICR7b2JqZWN0TmFtZX1gKVxuICAgIH1cbiAgICBpZiAoIWlzU3RyaW5nKGZpbGVQYXRoKSkge1xuICAgICAgdGhyb3cgbmV3IFR5cGVFcnJvcignZmlsZVBhdGggc2hvdWxkIGJlIG9mIHR5cGUgXCJzdHJpbmdcIicpXG4gICAgfVxuXG4gICAgY29uc3QgZG93bmxvYWRUb1RtcEZpbGUgPSBhc3luYyAoKTogUHJvbWlzZTxzdHJpbmc+ID0+IHtcbiAgICAgIGxldCBwYXJ0RmlsZVN0cmVhbTogc3RyZWFtLldyaXRhYmxlXG4gICAgICBjb25zdCBvYmpTdGF0ID0gYXdhaXQgdGhpcy5zdGF0T2JqZWN0KGJ1Y2tldE5hbWUsIG9iamVjdE5hbWUsIGdldE9wdHMpXG4gICAgICBjb25zdCBlbmNvZGVkRXRhZyA9IEJ1ZmZlci5mcm9tKG9ialN0YXQuZXRhZykudG9TdHJpbmcoJ2Jhc2U2NCcpXG4gICAgICBjb25zdCBwYXJ0RmlsZSA9IGAke2ZpbGVQYXRofS4ke2VuY29kZWRFdGFnfS5wYXJ0Lm1pbmlvYFxuXG4gICAgICBhd2FpdCBmc3AubWtkaXIocGF0aC5kaXJuYW1lKGZpbGVQYXRoKSwgeyByZWN1cnNpdmU6IHRydWUgfSlcblxuICAgICAgbGV0IG9mZnNldCA9IDBcbiAgICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IHN0YXRzID0gYXdhaXQgZnNwLnN0YXQocGFydEZpbGUpXG4gICAgICAgIGlmIChvYmpTdGF0LnNpemUgPT09IHN0YXRzLnNpemUpIHtcbiAgICAgICAgICByZXR1cm4gcGFydEZpbGVcbiAgICAgICAgfVxuICAgICAgICBvZmZzZXQgPSBzdGF0cy5zaXplXG4gICAgICAgIHBhcnRGaWxlU3RyZWFtID0gZnMuY3JlYXRlV3JpdGVTdHJlYW0ocGFydEZpbGUsIHsgZmxhZ3M6ICdhJyB9KVxuICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICBpZiAoZSBpbnN0YW5jZW9mIEVycm9yICYmIChlIGFzIHVua25vd24gYXMgeyBjb2RlOiBzdHJpbmcgfSkuY29kZSA9PT0gJ0VOT0VOVCcpIHtcbiAgICAgICAgICAvLyBmaWxlIG5vdCBleGlzdFxuICAgICAgICAgIHBhcnRGaWxlU3RyZWFtID0gZnMuY3JlYXRlV3JpdGVTdHJlYW0ocGFydEZpbGUsIHsgZmxhZ3M6ICd3JyB9KVxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIC8vIG90aGVyIGVycm9yLCBtYXliZSBhY2Nlc3MgZGVueVxuICAgICAgICAgIHRocm93IGVcbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICBjb25zdCBkb3dubG9hZFN0cmVhbSA9IGF3YWl0IHRoaXMuZ2V0UGFydGlhbE9iamVjdChidWNrZXROYW1lLCBvYmplY3ROYW1lLCBvZmZzZXQsIDAsIGdldE9wdHMpXG5cbiAgICAgIGF3YWl0IHN0cmVhbVByb21pc2UucGlwZWxpbmUoZG93bmxvYWRTdHJlYW0sIHBhcnRGaWxlU3RyZWFtKVxuICAgICAgY29uc3Qgc3RhdHMgPSBhd2FpdCBmc3Auc3RhdChwYXJ0RmlsZSlcbiAgICAgIGlmIChzdGF0cy5zaXplID09PSBvYmpTdGF0LnNpemUpIHtcbiAgICAgICAgcmV0dXJuIHBhcnRGaWxlXG4gICAgICB9XG5cbiAgICAgIHRocm93IG5ldyBFcnJvcignU2l6ZSBtaXNtYXRjaCBiZXR3ZWVuIGRvd25sb2FkZWQgZmlsZSBhbmQgdGhlIG9iamVjdCcpXG4gICAgfVxuXG4gICAgY29uc3QgcGFydEZpbGUgPSBhd2FpdCBkb3dubG9hZFRvVG1wRmlsZSgpXG4gICAgYXdhaXQgZnNwLnJlbmFtZShwYXJ0RmlsZSwgZmlsZVBhdGgpXG4gIH1cblxuICAvKipcbiAgICogU3RhdCBpbmZvcm1hdGlvbiBvZiB0aGUgb2JqZWN0LlxuICAgKi9cbiAgYXN5bmMgc3RhdE9iamVjdChidWNrZXROYW1lOiBzdHJpbmcsIG9iamVjdE5hbWU6IHN0cmluZywgc3RhdE9wdHM/OiBTdGF0T2JqZWN0T3B0cyk6IFByb21pc2U8QnVja2V0SXRlbVN0YXQ+IHtcbiAgICBjb25zdCBzdGF0T3B0RGVmID0gc3RhdE9wdHMgfHwge31cbiAgICBpZiAoIWlzVmFsaWRCdWNrZXROYW1lKGJ1Y2tldE5hbWUpKSB7XG4gICAgICB0aHJvdyBuZXcgZXJyb3JzLkludmFsaWRCdWNrZXROYW1lRXJyb3IoJ0ludmFsaWQgYnVja2V0IG5hbWU6ICcgKyBidWNrZXROYW1lKVxuICAgIH1cbiAgICBpZiAoIWlzVmFsaWRPYmplY3ROYW1lKG9iamVjdE5hbWUpKSB7XG4gICAgICB0aHJvdyBuZXcgZXJyb3JzLkludmFsaWRPYmplY3ROYW1lRXJyb3IoYEludmFsaWQgb2JqZWN0IG5hbWU6ICR7b2JqZWN0TmFtZX1gKVxuICAgIH1cblxuICAgIGlmICghaXNPYmplY3Qoc3RhdE9wdERlZikpIHtcbiAgICAgIHRocm93IG5ldyBlcnJvcnMuSW52YWxpZEFyZ3VtZW50RXJyb3IoJ3N0YXRPcHRzIHNob3VsZCBiZSBvZiB0eXBlIFwib2JqZWN0XCInKVxuICAgIH1cblxuICAgIGNvbnN0IHF1ZXJ5ID0gcXMuc3RyaW5naWZ5KHN0YXRPcHREZWYpXG4gICAgY29uc3QgbWV0aG9kID0gJ0hFQUQnXG4gICAgY29uc3QgcmVzID0gYXdhaXQgdGhpcy5tYWtlUmVxdWVzdEFzeW5jT21pdCh7IG1ldGhvZCwgYnVja2V0TmFtZSwgb2JqZWN0TmFtZSwgcXVlcnkgfSlcblxuICAgIHJldHVybiB7XG4gICAgICBzaXplOiBwYXJzZUludChyZXMuaGVhZGVyc1snY29udGVudC1sZW5ndGgnXSBhcyBzdHJpbmcpLFxuICAgICAgbWV0YURhdGE6IGV4dHJhY3RNZXRhZGF0YShyZXMuaGVhZGVycyBhcyBSZXNwb25zZUhlYWRlciksXG4gICAgICBsYXN0TW9kaWZpZWQ6IG5ldyBEYXRlKHJlcy5oZWFkZXJzWydsYXN0LW1vZGlmaWVkJ10gYXMgc3RyaW5nKSxcbiAgICAgIHZlcnNpb25JZDogZ2V0VmVyc2lvbklkKHJlcy5oZWFkZXJzIGFzIFJlc3BvbnNlSGVhZGVyKSxcbiAgICAgIGV0YWc6IHNhbml0aXplRVRhZyhyZXMuaGVhZGVycy5ldGFnKSxcbiAgICB9XG4gIH1cblxuICBhc3luYyByZW1vdmVPYmplY3QoYnVja2V0TmFtZTogc3RyaW5nLCBvYmplY3ROYW1lOiBzdHJpbmcsIHJlbW92ZU9wdHM/OiBSZW1vdmVPcHRpb25zKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgaWYgKCFpc1ZhbGlkQnVja2V0TmFtZShidWNrZXROYW1lKSkge1xuICAgICAgdGhyb3cgbmV3IGVycm9ycy5JbnZhbGlkQnVja2V0TmFtZUVycm9yKGBJbnZhbGlkIGJ1Y2tldCBuYW1lOiAke2J1Y2tldE5hbWV9YClcbiAgICB9XG4gICAgaWYgKCFpc1ZhbGlkT2JqZWN0TmFtZShvYmplY3ROYW1lKSkge1xuICAgICAgdGhyb3cgbmV3IGVycm9ycy5JbnZhbGlkT2JqZWN0TmFtZUVycm9yKGBJbnZhbGlkIG9iamVjdCBuYW1lOiAke29iamVjdE5hbWV9YClcbiAgICB9XG5cbiAgICBpZiAocmVtb3ZlT3B0cyAmJiAhaXNPYmplY3QocmVtb3ZlT3B0cykpIHtcbiAgICAgIHRocm93IG5ldyBlcnJvcnMuSW52YWxpZEFyZ3VtZW50RXJyb3IoJ3JlbW92ZU9wdHMgc2hvdWxkIGJlIG9mIHR5cGUgXCJvYmplY3RcIicpXG4gICAgfVxuXG4gICAgY29uc3QgbWV0aG9kID0gJ0RFTEVURSdcblxuICAgIGNvbnN0IGhlYWRlcnM6IFJlcXVlc3RIZWFkZXJzID0ge31cbiAgICBpZiAocmVtb3ZlT3B0cz8uZ292ZXJuYW5jZUJ5cGFzcykge1xuICAgICAgaGVhZGVyc1snWC1BbXotQnlwYXNzLUdvdmVybmFuY2UtUmV0ZW50aW9uJ10gPSB0cnVlXG4gICAgfVxuICAgIGlmIChyZW1vdmVPcHRzPy5mb3JjZURlbGV0ZSkge1xuICAgICAgaGVhZGVyc1sneC1taW5pby1mb3JjZS1kZWxldGUnXSA9IHRydWVcbiAgICB9XG5cbiAgICBjb25zdCBxdWVyeVBhcmFtczogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHt9XG4gICAgaWYgKHJlbW92ZU9wdHM/LnZlcnNpb25JZCkge1xuICAgICAgcXVlcnlQYXJhbXMudmVyc2lvbklkID0gYCR7cmVtb3ZlT3B0cy52ZXJzaW9uSWR9YFxuICAgIH1cbiAgICBjb25zdCBxdWVyeSA9IHFzLnN0cmluZ2lmeShxdWVyeVBhcmFtcylcblxuICAgIGF3YWl0IHRoaXMubWFrZVJlcXVlc3RBc3luY09taXQoeyBtZXRob2QsIGJ1Y2tldE5hbWUsIG9iamVjdE5hbWUsIGhlYWRlcnMsIHF1ZXJ5IH0sICcnLCBbMjAwLCAyMDRdKVxuICB9XG5cbiAgLy8gQ2FsbHMgaW1wbGVtZW50ZWQgYmVsb3cgYXJlIHJlbGF0ZWQgdG8gbXVsdGlwYXJ0LlxuXG4gIGxpc3RJbmNvbXBsZXRlVXBsb2FkcyhcbiAgICBidWNrZXQ6IHN0cmluZyxcbiAgICBwcmVmaXg6IHN0cmluZyxcbiAgICByZWN1cnNpdmU6IGJvb2xlYW4sXG4gICk6IEJ1Y2tldFN0cmVhbTxJbmNvbXBsZXRlVXBsb2FkZWRCdWNrZXRJdGVtPiB7XG4gICAgaWYgKHByZWZpeCA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICBwcmVmaXggPSAnJ1xuICAgIH1cbiAgICBpZiAocmVjdXJzaXZlID09PSB1bmRlZmluZWQpIHtcbiAgICAgIHJlY3Vyc2l2ZSA9IGZhbHNlXG4gICAgfVxuICAgIGlmICghaXNWYWxpZEJ1Y2tldE5hbWUoYnVja2V0KSkge1xuICAgICAgdGhyb3cgbmV3IGVycm9ycy5JbnZhbGlkQnVja2V0TmFtZUVycm9yKCdJbnZhbGlkIGJ1Y2tldCBuYW1lOiAnICsgYnVja2V0KVxuICAgIH1cbiAgICBpZiAoIWlzVmFsaWRQcmVmaXgocHJlZml4KSkge1xuICAgICAgdGhyb3cgbmV3IGVycm9ycy5JbnZhbGlkUHJlZml4RXJyb3IoYEludmFsaWQgcHJlZml4IDogJHtwcmVmaXh9YClcbiAgICB9XG4gICAgaWYgKCFpc0Jvb2xlYW4ocmVjdXJzaXZlKSkge1xuICAgICAgdGhyb3cgbmV3IFR5cGVFcnJvcigncmVjdXJzaXZlIHNob3VsZCBiZSBvZiB0eXBlIFwiYm9vbGVhblwiJylcbiAgICB9XG4gICAgY29uc3QgZGVsaW1pdGVyID0gcmVjdXJzaXZlID8gJycgOiAnLydcbiAgICBsZXQga2V5TWFya2VyID0gJydcbiAgICBsZXQgdXBsb2FkSWRNYXJrZXIgPSAnJ1xuICAgIGNvbnN0IHVwbG9hZHM6IHVua25vd25bXSA9IFtdXG4gICAgbGV0IGVuZGVkID0gZmFsc2VcblxuICAgIC8vIFRPRE86IHJlZmFjdG9yIHRoaXMgd2l0aCBhc3luYy9hd2FpdCBhbmQgYHN0cmVhbS5SZWFkYWJsZS5mcm9tYFxuICAgIGNvbnN0IHJlYWRTdHJlYW0gPSBuZXcgc3RyZWFtLlJlYWRhYmxlKHsgb2JqZWN0TW9kZTogdHJ1ZSB9KVxuICAgIHJlYWRTdHJlYW0uX3JlYWQgPSAoKSA9PiB7XG4gICAgICAvLyBwdXNoIG9uZSB1cGxvYWQgaW5mbyBwZXIgX3JlYWQoKVxuICAgICAgaWYgKHVwbG9hZHMubGVuZ3RoKSB7XG4gICAgICAgIHJldHVybiByZWFkU3RyZWFtLnB1c2godXBsb2Fkcy5zaGlmdCgpKVxuICAgICAgfVxuICAgICAgaWYgKGVuZGVkKSB7XG4gICAgICAgIHJldHVybiByZWFkU3RyZWFtLnB1c2gobnVsbClcbiAgICAgIH1cbiAgICAgIHRoaXMubGlzdEluY29tcGxldGVVcGxvYWRzUXVlcnkoYnVja2V0LCBwcmVmaXgsIGtleU1hcmtlciwgdXBsb2FkSWRNYXJrZXIsIGRlbGltaXRlcikudGhlbihcbiAgICAgICAgKHJlc3VsdCkgPT4ge1xuICAgICAgICAgIC8vIGVzbGludC1kaXNhYmxlLW5leHQtbGluZSBAdHlwZXNjcmlwdC1lc2xpbnQvYmFuLXRzLWNvbW1lbnRcbiAgICAgICAgICAvLyBAdHMtaWdub3JlXG4gICAgICAgICAgcmVzdWx0LnByZWZpeGVzLmZvckVhY2goKHByZWZpeCkgPT4gdXBsb2Fkcy5wdXNoKHByZWZpeCkpXG4gICAgICAgICAgYXN5bmMuZWFjaFNlcmllcyhcbiAgICAgICAgICAgIHJlc3VsdC51cGxvYWRzLFxuICAgICAgICAgICAgKHVwbG9hZCwgY2IpID0+IHtcbiAgICAgICAgICAgICAgLy8gZm9yIGVhY2ggaW5jb21wbGV0ZSB1cGxvYWQgYWRkIHRoZSBzaXplcyBvZiBpdHMgdXBsb2FkZWQgcGFydHNcbiAgICAgICAgICAgICAgLy8gZXNsaW50LWRpc2FibGUtbmV4dC1saW5lIEB0eXBlc2NyaXB0LWVzbGludC9iYW4tdHMtY29tbWVudFxuICAgICAgICAgICAgICAvLyBAdHMtaWdub3JlXG4gICAgICAgICAgICAgIHRoaXMubGlzdFBhcnRzKGJ1Y2tldCwgdXBsb2FkLmtleSwgdXBsb2FkLnVwbG9hZElkKS50aGVuKFxuICAgICAgICAgICAgICAgIChwYXJ0czogUGFydFtdKSA9PiB7XG4gICAgICAgICAgICAgICAgICAvLyBlc2xpbnQtZGlzYWJsZS1uZXh0LWxpbmUgQHR5cGVzY3JpcHQtZXNsaW50L2Jhbi10cy1jb21tZW50XG4gICAgICAgICAgICAgICAgICAvLyBAdHMtaWdub3JlXG4gICAgICAgICAgICAgICAgICB1cGxvYWQuc2l6ZSA9IHBhcnRzLnJlZHVjZSgoYWNjLCBpdGVtKSA9PiBhY2MgKyBpdGVtLnNpemUsIDApXG4gICAgICAgICAgICAgICAgICB1cGxvYWRzLnB1c2godXBsb2FkKVxuICAgICAgICAgICAgICAgICAgY2IoKVxuICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgKGVycjogRXJyb3IpID0+IGNiKGVyciksXG4gICAgICAgICAgICAgIClcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAoZXJyKSA9PiB7XG4gICAgICAgICAgICAgIGlmIChlcnIpIHtcbiAgICAgICAgICAgICAgICByZWFkU3RyZWFtLmVtaXQoJ2Vycm9yJywgZXJyKVxuICAgICAgICAgICAgICAgIHJldHVyblxuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgIGlmIChyZXN1bHQuaXNUcnVuY2F0ZWQpIHtcbiAgICAgICAgICAgICAgICBrZXlNYXJrZXIgPSByZXN1bHQubmV4dEtleU1hcmtlclxuICAgICAgICAgICAgICAgIHVwbG9hZElkTWFya2VyID0gcmVzdWx0Lm5leHRVcGxvYWRJZE1hcmtlclxuICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIGVuZGVkID0gdHJ1ZVxuICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgLy8gZXNsaW50LWRpc2FibGUtbmV4dC1saW5lIEB0eXBlc2NyaXB0LWVzbGludC9iYW4tdHMtY29tbWVudFxuICAgICAgICAgICAgICAvLyBAdHMtaWdub3JlXG4gICAgICAgICAgICAgIHJlYWRTdHJlYW0uX3JlYWQoKVxuICAgICAgICAgICAgfSxcbiAgICAgICAgICApXG4gICAgICAgIH0sXG4gICAgICAgIChlKSA9PiB7XG4gICAgICAgICAgcmVhZFN0cmVhbS5lbWl0KCdlcnJvcicsIGUpXG4gICAgICAgIH0sXG4gICAgICApXG4gICAgfVxuICAgIHJldHVybiByZWFkU3RyZWFtXG4gIH1cblxuICAvKipcbiAgICogQ2FsbGVkIGJ5IGxpc3RJbmNvbXBsZXRlVXBsb2FkcyB0byBmZXRjaCBhIGJhdGNoIG9mIGluY29tcGxldGUgdXBsb2Fkcy5cbiAgICovXG4gIGFzeW5jIGxpc3RJbmNvbXBsZXRlVXBsb2Fkc1F1ZXJ5KFxuICAgIGJ1Y2tldE5hbWU6IHN0cmluZyxcbiAgICBwcmVmaXg6IHN0cmluZyxcbiAgICBrZXlNYXJrZXI6IHN0cmluZyxcbiAgICB1cGxvYWRJZE1hcmtlcjogc3RyaW5nLFxuICAgIGRlbGltaXRlcjogc3RyaW5nLFxuICApOiBQcm9taXNlPExpc3RNdWx0aXBhcnRSZXN1bHQ+IHtcbiAgICBpZiAoIWlzVmFsaWRCdWNrZXROYW1lKGJ1Y2tldE5hbWUpKSB7XG4gICAgICB0aHJvdyBuZXcgZXJyb3JzLkludmFsaWRCdWNrZXROYW1lRXJyb3IoJ0ludmFsaWQgYnVja2V0IG5hbWU6ICcgKyBidWNrZXROYW1lKVxuICAgIH1cbiAgICBpZiAoIWlzU3RyaW5nKHByZWZpeCkpIHtcbiAgICAgIHRocm93IG5ldyBUeXBlRXJyb3IoJ3ByZWZpeCBzaG91bGQgYmUgb2YgdHlwZSBcInN0cmluZ1wiJylcbiAgICB9XG4gICAgaWYgKCFpc1N0cmluZyhrZXlNYXJrZXIpKSB7XG4gICAgICB0aHJvdyBuZXcgVHlwZUVycm9yKCdrZXlNYXJrZXIgc2hvdWxkIGJlIG9mIHR5cGUgXCJzdHJpbmdcIicpXG4gICAgfVxuICAgIGlmICghaXNTdHJpbmcodXBsb2FkSWRNYXJrZXIpKSB7XG4gICAgICB0aHJvdyBuZXcgVHlwZUVycm9yKCd1cGxvYWRJZE1hcmtlciBzaG91bGQgYmUgb2YgdHlwZSBcInN0cmluZ1wiJylcbiAgICB9XG4gICAgaWYgKCFpc1N0cmluZyhkZWxpbWl0ZXIpKSB7XG4gICAgICB0aHJvdyBuZXcgVHlwZUVycm9yKCdkZWxpbWl0ZXIgc2hvdWxkIGJlIG9mIHR5cGUgXCJzdHJpbmdcIicpXG4gICAgfVxuICAgIGNvbnN0IHF1ZXJpZXMgPSBbXVxuICAgIHF1ZXJpZXMucHVzaChgcHJlZml4PSR7dXJpRXNjYXBlKHByZWZpeCl9YClcbiAgICBxdWVyaWVzLnB1c2goYGRlbGltaXRlcj0ke3VyaUVzY2FwZShkZWxpbWl0ZXIpfWApXG5cbiAgICBpZiAoa2V5TWFya2VyKSB7XG4gICAgICBxdWVyaWVzLnB1c2goYGtleS1tYXJrZXI9JHt1cmlFc2NhcGUoa2V5TWFya2VyKX1gKVxuICAgIH1cbiAgICBpZiAodXBsb2FkSWRNYXJrZXIpIHtcbiAgICAgIHF1ZXJpZXMucHVzaChgdXBsb2FkLWlkLW1hcmtlcj0ke3VwbG9hZElkTWFya2VyfWApXG4gICAgfVxuXG4gICAgY29uc3QgbWF4VXBsb2FkcyA9IDEwMDBcbiAgICBxdWVyaWVzLnB1c2goYG1heC11cGxvYWRzPSR7bWF4VXBsb2Fkc31gKVxuICAgIHF1ZXJpZXMuc29ydCgpXG4gICAgcXVlcmllcy51bnNoaWZ0KCd1cGxvYWRzJylcbiAgICBsZXQgcXVlcnkgPSAnJ1xuICAgIGlmIChxdWVyaWVzLmxlbmd0aCA+IDApIHtcbiAgICAgIHF1ZXJ5ID0gYCR7cXVlcmllcy5qb2luKCcmJyl9YFxuICAgIH1cbiAgICBjb25zdCBtZXRob2QgPSAnR0VUJ1xuICAgIGNvbnN0IHJlcyA9IGF3YWl0IHRoaXMubWFrZVJlcXVlc3RBc3luYyh7IG1ldGhvZCwgYnVja2V0TmFtZSwgcXVlcnkgfSlcbiAgICBjb25zdCBib2R5ID0gYXdhaXQgcmVhZEFzU3RyaW5nKHJlcylcbiAgICByZXR1cm4geG1sUGFyc2Vycy5wYXJzZUxpc3RNdWx0aXBhcnQoYm9keSlcbiAgfVxuXG4gIC8qKlxuICAgKiBJbml0aWF0ZSBhIG5ldyBtdWx0aXBhcnQgdXBsb2FkLlxuICAgKiBAaW50ZXJuYWxcbiAgICovXG4gIGFzeW5jIGluaXRpYXRlTmV3TXVsdGlwYXJ0VXBsb2FkKGJ1Y2tldE5hbWU6IHN0cmluZywgb2JqZWN0TmFtZTogc3RyaW5nLCBoZWFkZXJzOiBSZXF1ZXN0SGVhZGVycyk6IFByb21pc2U8c3RyaW5nPiB7XG4gICAgaWYgKCFpc1ZhbGlkQnVja2V0TmFtZShidWNrZXROYW1lKSkge1xuICAgICAgdGhyb3cgbmV3IGVycm9ycy5JbnZhbGlkQnVja2V0TmFtZUVycm9yKCdJbnZhbGlkIGJ1Y2tldCBuYW1lOiAnICsgYnVja2V0TmFtZSlcbiAgICB9XG4gICAgaWYgKCFpc1ZhbGlkT2JqZWN0TmFtZShvYmplY3ROYW1lKSkge1xuICAgICAgdGhyb3cgbmV3IGVycm9ycy5JbnZhbGlkT2JqZWN0TmFtZUVycm9yKGBJbnZhbGlkIG9iamVjdCBuYW1lOiAke29iamVjdE5hbWV9YClcbiAgICB9XG4gICAgaWYgKCFpc09iamVjdChoZWFkZXJzKSkge1xuICAgICAgdGhyb3cgbmV3IGVycm9ycy5JbnZhbGlkT2JqZWN0TmFtZUVycm9yKCdjb250ZW50VHlwZSBzaG91bGQgYmUgb2YgdHlwZSBcIm9iamVjdFwiJylcbiAgICB9XG4gICAgY29uc3QgbWV0aG9kID0gJ1BPU1QnXG4gICAgY29uc3QgcXVlcnkgPSAndXBsb2FkcydcbiAgICBjb25zdCByZXMgPSBhd2FpdCB0aGlzLm1ha2VSZXF1ZXN0QXN5bmMoeyBtZXRob2QsIGJ1Y2tldE5hbWUsIG9iamVjdE5hbWUsIHF1ZXJ5LCBoZWFkZXJzIH0pXG4gICAgY29uc3QgYm9keSA9IGF3YWl0IHJlYWRBc0J1ZmZlcihyZXMpXG4gICAgcmV0dXJuIHBhcnNlSW5pdGlhdGVNdWx0aXBhcnQoYm9keS50b1N0cmluZygpKVxuICB9XG5cbiAgLyoqXG4gICAqIEludGVybmFsIE1ldGhvZCB0byBhYm9ydCBhIG11bHRpcGFydCB1cGxvYWQgcmVxdWVzdCBpbiBjYXNlIG9mIGFueSBlcnJvcnMuXG4gICAqXG4gICAqIEBwYXJhbSBidWNrZXROYW1lIC0gQnVja2V0IE5hbWVcbiAgICogQHBhcmFtIG9iamVjdE5hbWUgLSBPYmplY3QgTmFtZVxuICAgKiBAcGFyYW0gdXBsb2FkSWQgLSBpZCBvZiBhIG11bHRpcGFydCB1cGxvYWQgdG8gY2FuY2VsIGR1cmluZyBjb21wb3NlIG9iamVjdCBzZXF1ZW5jZS5cbiAgICovXG4gIGFzeW5jIGFib3J0TXVsdGlwYXJ0VXBsb2FkKGJ1Y2tldE5hbWU6IHN0cmluZywgb2JqZWN0TmFtZTogc3RyaW5nLCB1cGxvYWRJZDogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgY29uc3QgbWV0aG9kID0gJ0RFTEVURSdcbiAgICBjb25zdCBxdWVyeSA9IGB1cGxvYWRJZD0ke3VwbG9hZElkfWBcblxuICAgIGNvbnN0IHJlcXVlc3RPcHRpb25zID0geyBtZXRob2QsIGJ1Y2tldE5hbWUsIG9iamVjdE5hbWU6IG9iamVjdE5hbWUsIHF1ZXJ5IH1cbiAgICBhd2FpdCB0aGlzLm1ha2VSZXF1ZXN0QXN5bmNPbWl0KHJlcXVlc3RPcHRpb25zLCAnJywgWzIwNF0pXG4gIH1cblxuICBhc3luYyBmaW5kVXBsb2FkSWQoYnVja2V0TmFtZTogc3RyaW5nLCBvYmplY3ROYW1lOiBzdHJpbmcpOiBQcm9taXNlPHN0cmluZyB8IHVuZGVmaW5lZD4ge1xuICAgIGlmICghaXNWYWxpZEJ1Y2tldE5hbWUoYnVja2V0TmFtZSkpIHtcbiAgICAgIHRocm93IG5ldyBlcnJvcnMuSW52YWxpZEJ1Y2tldE5hbWVFcnJvcignSW52YWxpZCBidWNrZXQgbmFtZTogJyArIGJ1Y2tldE5hbWUpXG4gICAgfVxuICAgIGlmICghaXNWYWxpZE9iamVjdE5hbWUob2JqZWN0TmFtZSkpIHtcbiAgICAgIHRocm93IG5ldyBlcnJvcnMuSW52YWxpZE9iamVjdE5hbWVFcnJvcihgSW52YWxpZCBvYmplY3QgbmFtZTogJHtvYmplY3ROYW1lfWApXG4gICAgfVxuXG4gICAgbGV0IGxhdGVzdFVwbG9hZDogTGlzdE11bHRpcGFydFJlc3VsdFsndXBsb2FkcyddW251bWJlcl0gfCB1bmRlZmluZWRcbiAgICBsZXQga2V5TWFya2VyID0gJydcbiAgICBsZXQgdXBsb2FkSWRNYXJrZXIgPSAnJ1xuICAgIGZvciAoOzspIHtcbiAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHRoaXMubGlzdEluY29tcGxldGVVcGxvYWRzUXVlcnkoYnVja2V0TmFtZSwgb2JqZWN0TmFtZSwga2V5TWFya2VyLCB1cGxvYWRJZE1hcmtlciwgJycpXG4gICAgICBmb3IgKGNvbnN0IHVwbG9hZCBvZiByZXN1bHQudXBsb2Fkcykge1xuICAgICAgICBpZiAodXBsb2FkLmtleSA9PT0gb2JqZWN0TmFtZSkge1xuICAgICAgICAgIGlmICghbGF0ZXN0VXBsb2FkIHx8IHVwbG9hZC5pbml0aWF0ZWQuZ2V0VGltZSgpID4gbGF0ZXN0VXBsb2FkLmluaXRpYXRlZC5nZXRUaW1lKCkpIHtcbiAgICAgICAgICAgIGxhdGVzdFVwbG9hZCA9IHVwbG9hZFxuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgaWYgKHJlc3VsdC5pc1RydW5jYXRlZCkge1xuICAgICAgICBrZXlNYXJrZXIgPSByZXN1bHQubmV4dEtleU1hcmtlclxuICAgICAgICB1cGxvYWRJZE1hcmtlciA9IHJlc3VsdC5uZXh0VXBsb2FkSWRNYXJrZXJcbiAgICAgICAgY29udGludWVcbiAgICAgIH1cblxuICAgICAgYnJlYWtcbiAgICB9XG4gICAgcmV0dXJuIGxhdGVzdFVwbG9hZD8udXBsb2FkSWRcbiAgfVxuXG4gIC8qKlxuICAgKiB0aGlzIGNhbGwgd2lsbCBhZ2dyZWdhdGUgdGhlIHBhcnRzIG9uIHRoZSBzZXJ2ZXIgaW50byBhIHNpbmdsZSBvYmplY3QuXG4gICAqL1xuICBhc3luYyBjb21wbGV0ZU11bHRpcGFydFVwbG9hZChcbiAgICBidWNrZXROYW1lOiBzdHJpbmcsXG4gICAgb2JqZWN0TmFtZTogc3RyaW5nLFxuICAgIHVwbG9hZElkOiBzdHJpbmcsXG4gICAgZXRhZ3M6IHtcbiAgICAgIHBhcnQ6IG51bWJlclxuICAgICAgZXRhZz86IHN0cmluZ1xuICAgIH1bXSxcbiAgKTogUHJvbWlzZTx7IGV0YWc6IHN0cmluZzsgdmVyc2lvbklkOiBzdHJpbmcgfCBudWxsIH0+IHtcbiAgICBpZiAoIWlzVmFsaWRCdWNrZXROYW1lKGJ1Y2tldE5hbWUpKSB7XG4gICAgICB0aHJvdyBuZXcgZXJyb3JzLkludmFsaWRCdWNrZXROYW1lRXJyb3IoJ0ludmFsaWQgYnVja2V0IG5hbWU6ICcgKyBidWNrZXROYW1lKVxuICAgIH1cbiAgICBpZiAoIWlzVmFsaWRPYmplY3ROYW1lKG9iamVjdE5hbWUpKSB7XG4gICAgICB0aHJvdyBuZXcgZXJyb3JzLkludmFsaWRPYmplY3ROYW1lRXJyb3IoYEludmFsaWQgb2JqZWN0IG5hbWU6ICR7b2JqZWN0TmFtZX1gKVxuICAgIH1cbiAgICBpZiAoIWlzU3RyaW5nKHVwbG9hZElkKSkge1xuICAgICAgdGhyb3cgbmV3IFR5cGVFcnJvcigndXBsb2FkSWQgc2hvdWxkIGJlIG9mIHR5cGUgXCJzdHJpbmdcIicpXG4gICAgfVxuICAgIGlmICghaXNPYmplY3QoZXRhZ3MpKSB7XG4gICAgICB0aHJvdyBuZXcgVHlwZUVycm9yKCdldGFncyBzaG91bGQgYmUgb2YgdHlwZSBcIkFycmF5XCInKVxuICAgIH1cblxuICAgIGlmICghdXBsb2FkSWQpIHtcbiAgICAgIHRocm93IG5ldyBlcnJvcnMuSW52YWxpZEFyZ3VtZW50RXJyb3IoJ3VwbG9hZElkIGNhbm5vdCBiZSBlbXB0eScpXG4gICAgfVxuXG4gICAgY29uc3QgbWV0aG9kID0gJ1BPU1QnXG4gICAgY29uc3QgcXVlcnkgPSBgdXBsb2FkSWQ9JHt1cmlFc2NhcGUodXBsb2FkSWQpfWBcblxuICAgIGNvbnN0IGJ1aWxkZXIgPSBuZXcgeG1sMmpzLkJ1aWxkZXIoKVxuICAgIGNvbnN0IHBheWxvYWQgPSBidWlsZGVyLmJ1aWxkT2JqZWN0KHtcbiAgICAgIENvbXBsZXRlTXVsdGlwYXJ0VXBsb2FkOiB7XG4gICAgICAgICQ6IHtcbiAgICAgICAgICB4bWxuczogJ2h0dHA6Ly9zMy5hbWF6b25hd3MuY29tL2RvYy8yMDA2LTAzLTAxLycsXG4gICAgICAgIH0sXG4gICAgICAgIFBhcnQ6IGV0YWdzLm1hcCgoZXRhZykgPT4ge1xuICAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICBQYXJ0TnVtYmVyOiBldGFnLnBhcnQsXG4gICAgICAgICAgICBFVGFnOiBldGFnLmV0YWcsXG4gICAgICAgICAgfVxuICAgICAgICB9KSxcbiAgICAgIH0sXG4gICAgfSlcblxuICAgIGNvbnN0IHJlcyA9IGF3YWl0IHRoaXMubWFrZVJlcXVlc3RBc3luYyh7IG1ldGhvZCwgYnVja2V0TmFtZSwgb2JqZWN0TmFtZSwgcXVlcnkgfSwgcGF5bG9hZClcbiAgICBjb25zdCBib2R5ID0gYXdhaXQgcmVhZEFzQnVmZmVyKHJlcylcbiAgICBjb25zdCByZXN1bHQgPSBwYXJzZUNvbXBsZXRlTXVsdGlwYXJ0KGJvZHkudG9TdHJpbmcoKSlcbiAgICBpZiAoIXJlc3VsdCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKCdCVUc6IGZhaWxlZCB0byBwYXJzZSBzZXJ2ZXIgcmVzcG9uc2UnKVxuICAgIH1cblxuICAgIGlmIChyZXN1bHQuZXJyQ29kZSkge1xuICAgICAgLy8gTXVsdGlwYXJ0IENvbXBsZXRlIEFQSSByZXR1cm5zIGFuIGVycm9yIFhNTCBhZnRlciBhIDIwMCBodHRwIHN0YXR1c1xuICAgICAgdGhyb3cgbmV3IGVycm9ycy5TM0Vycm9yKHJlc3VsdC5lcnJNZXNzYWdlKVxuICAgIH1cblxuICAgIHJldHVybiB7XG4gICAgICAvLyBlc2xpbnQtZGlzYWJsZS1uZXh0LWxpbmUgQHR5cGVzY3JpcHQtZXNsaW50L2Jhbi10cy1jb21tZW50XG4gICAgICAvLyBAdHMtaWdub3JlXG4gICAgICBldGFnOiByZXN1bHQuZXRhZyBhcyBzdHJpbmcsXG4gICAgICB2ZXJzaW9uSWQ6IGdldFZlcnNpb25JZChyZXMuaGVhZGVycyBhcyBSZXNwb25zZUhlYWRlciksXG4gICAgfVxuICB9XG5cbiAgLyoqXG4gICAqIEdldCBwYXJ0LWluZm8gb2YgYWxsIHBhcnRzIG9mIGFuIGluY29tcGxldGUgdXBsb2FkIHNwZWNpZmllZCBieSB1cGxvYWRJZC5cbiAgICovXG4gIHByb3RlY3RlZCBhc3luYyBsaXN0UGFydHMoYnVja2V0TmFtZTogc3RyaW5nLCBvYmplY3ROYW1lOiBzdHJpbmcsIHVwbG9hZElkOiBzdHJpbmcpOiBQcm9taXNlPFVwbG9hZGVkUGFydFtdPiB7XG4gICAgaWYgKCFpc1ZhbGlkQnVja2V0TmFtZShidWNrZXROYW1lKSkge1xuICAgICAgdGhyb3cgbmV3IGVycm9ycy5JbnZhbGlkQnVja2V0TmFtZUVycm9yKCdJbnZhbGlkIGJ1Y2tldCBuYW1lOiAnICsgYnVja2V0TmFtZSlcbiAgICB9XG4gICAgaWYgKCFpc1ZhbGlkT2JqZWN0TmFtZShvYmplY3ROYW1lKSkge1xuICAgICAgdGhyb3cgbmV3IGVycm9ycy5JbnZhbGlkT2JqZWN0TmFtZUVycm9yKGBJbnZhbGlkIG9iamVjdCBuYW1lOiAke29iamVjdE5hbWV9YClcbiAgICB9XG4gICAgaWYgKCFpc1N0cmluZyh1cGxvYWRJZCkpIHtcbiAgICAgIHRocm93IG5ldyBUeXBlRXJyb3IoJ3VwbG9hZElkIHNob3VsZCBiZSBvZiB0eXBlIFwic3RyaW5nXCInKVxuICAgIH1cbiAgICBpZiAoIXVwbG9hZElkKSB7XG4gICAgICB0aHJvdyBuZXcgZXJyb3JzLkludmFsaWRBcmd1bWVudEVycm9yKCd1cGxvYWRJZCBjYW5ub3QgYmUgZW1wdHknKVxuICAgIH1cblxuICAgIGNvbnN0IHBhcnRzOiBVcGxvYWRlZFBhcnRbXSA9IFtdXG4gICAgbGV0IG1hcmtlciA9IDBcbiAgICBsZXQgcmVzdWx0XG4gICAgZG8ge1xuICAgICAgcmVzdWx0ID0gYXdhaXQgdGhpcy5saXN0UGFydHNRdWVyeShidWNrZXROYW1lLCBvYmplY3ROYW1lLCB1cGxvYWRJZCwgbWFya2VyKVxuICAgICAgbWFya2VyID0gcmVzdWx0Lm1hcmtlclxuICAgICAgcGFydHMucHVzaCguLi5yZXN1bHQucGFydHMpXG4gICAgfSB3aGlsZSAocmVzdWx0LmlzVHJ1bmNhdGVkKVxuXG4gICAgcmV0dXJuIHBhcnRzXG4gIH1cblxuICAvKipcbiAgICogQ2FsbGVkIGJ5IGxpc3RQYXJ0cyB0byBmZXRjaCBhIGJhdGNoIG9mIHBhcnQtaW5mb1xuICAgKi9cbiAgcHJpdmF0ZSBhc3luYyBsaXN0UGFydHNRdWVyeShidWNrZXROYW1lOiBzdHJpbmcsIG9iamVjdE5hbWU6IHN0cmluZywgdXBsb2FkSWQ6IHN0cmluZywgbWFya2VyOiBudW1iZXIpIHtcbiAgICBpZiAoIWlzVmFsaWRCdWNrZXROYW1lKGJ1Y2tldE5hbWUpKSB7XG4gICAgICB0aHJvdyBuZXcgZXJyb3JzLkludmFsaWRCdWNrZXROYW1lRXJyb3IoJ0ludmFsaWQgYnVja2V0IG5hbWU6ICcgKyBidWNrZXROYW1lKVxuICAgIH1cbiAgICBpZiAoIWlzVmFsaWRPYmplY3ROYW1lKG9iamVjdE5hbWUpKSB7XG4gICAgICB0aHJvdyBuZXcgZXJyb3JzLkludmFsaWRPYmplY3ROYW1lRXJyb3IoYEludmFsaWQgb2JqZWN0IG5hbWU6ICR7b2JqZWN0TmFtZX1gKVxuICAgIH1cbiAgICBpZiAoIWlzU3RyaW5nKHVwbG9hZElkKSkge1xuICAgICAgdGhyb3cgbmV3IFR5cGVFcnJvcigndXBsb2FkSWQgc2hvdWxkIGJlIG9mIHR5cGUgXCJzdHJpbmdcIicpXG4gICAgfVxuICAgIGlmICghaXNOdW1iZXIobWFya2VyKSkge1xuICAgICAgdGhyb3cgbmV3IFR5cGVFcnJvcignbWFya2VyIHNob3VsZCBiZSBvZiB0eXBlIFwibnVtYmVyXCInKVxuICAgIH1cbiAgICBpZiAoIXVwbG9hZElkKSB7XG4gICAgICB0aHJvdyBuZXcgZXJyb3JzLkludmFsaWRBcmd1bWVudEVycm9yKCd1cGxvYWRJZCBjYW5ub3QgYmUgZW1wdHknKVxuICAgIH1cblxuICAgIGxldCBxdWVyeSA9IGB1cGxvYWRJZD0ke3VyaUVzY2FwZSh1cGxvYWRJZCl9YFxuICAgIGlmIChtYXJrZXIpIHtcbiAgICAgIHF1ZXJ5ICs9IGAmcGFydC1udW1iZXItbWFya2VyPSR7bWFya2VyfWBcbiAgICB9XG5cbiAgICBjb25zdCBtZXRob2QgPSAnR0VUJ1xuICAgIGNvbnN0IHJlcyA9IGF3YWl0IHRoaXMubWFrZVJlcXVlc3RBc3luYyh7IG1ldGhvZCwgYnVja2V0TmFtZSwgb2JqZWN0TmFtZSwgcXVlcnkgfSlcbiAgICByZXR1cm4geG1sUGFyc2Vycy5wYXJzZUxpc3RQYXJ0cyhhd2FpdCByZWFkQXNTdHJpbmcocmVzKSlcbiAgfVxuXG4gIGFzeW5jIGxpc3RCdWNrZXRzKCk6IFByb21pc2U8QnVja2V0SXRlbUZyb21MaXN0W10+IHtcbiAgICBjb25zdCBtZXRob2QgPSAnR0VUJ1xuICAgIGNvbnN0IHJlZ2lvbkNvbmYgPSB0aGlzLnJlZ2lvbiB8fCBERUZBVUxUX1JFR0lPTlxuICAgIGNvbnN0IGh0dHBSZXMgPSBhd2FpdCB0aGlzLm1ha2VSZXF1ZXN0QXN5bmMoeyBtZXRob2QgfSwgJycsIFsyMDBdLCByZWdpb25Db25mKVxuICAgIGNvbnN0IHhtbFJlc3VsdCA9IGF3YWl0IHJlYWRBc1N0cmluZyhodHRwUmVzKVxuICAgIHJldHVybiB4bWxQYXJzZXJzLnBhcnNlTGlzdEJ1Y2tldCh4bWxSZXN1bHQpXG4gIH1cblxuICAvKipcbiAgICogQ2FsY3VsYXRlIHBhcnQgc2l6ZSBnaXZlbiB0aGUgb2JqZWN0IHNpemUuIFBhcnQgc2l6ZSB3aWxsIGJlIGF0bGVhc3QgdGhpcy5wYXJ0U2l6ZVxuICAgKi9cbiAgY2FsY3VsYXRlUGFydFNpemUoc2l6ZTogbnVtYmVyKSB7XG4gICAgaWYgKCFpc051bWJlcihzaXplKSkge1xuICAgICAgdGhyb3cgbmV3IFR5cGVFcnJvcignc2l6ZSBzaG91bGQgYmUgb2YgdHlwZSBcIm51bWJlclwiJylcbiAgICB9XG4gICAgaWYgKHNpemUgPiB0aGlzLm1heE9iamVjdFNpemUpIHtcbiAgICAgIHRocm93IG5ldyBUeXBlRXJyb3IoYHNpemUgc2hvdWxkIG5vdCBiZSBtb3JlIHRoYW4gJHt0aGlzLm1heE9iamVjdFNpemV9YClcbiAgICB9XG4gICAgaWYgKHRoaXMub3ZlclJpZGVQYXJ0U2l6ZSkge1xuICAgICAgcmV0dXJuIHRoaXMucGFydFNpemVcbiAgICB9XG4gICAgbGV0IHBhcnRTaXplID0gdGhpcy5wYXJ0U2l6ZVxuICAgIGZvciAoOzspIHtcbiAgICAgIC8vIHdoaWxlKHRydWUpIHsuLi59IHRocm93cyBsaW50aW5nIGVycm9yLlxuICAgICAgLy8gSWYgcGFydFNpemUgaXMgYmlnIGVub3VnaCB0byBhY2NvbW9kYXRlIHRoZSBvYmplY3Qgc2l6ZSwgdGhlbiB1c2UgaXQuXG4gICAgICBpZiAocGFydFNpemUgKiAxMDAwMCA+IHNpemUpIHtcbiAgICAgICAgcmV0dXJuIHBhcnRTaXplXG4gICAgICB9XG4gICAgICAvLyBUcnkgcGFydCBzaXplcyBhcyA2NE1CLCA4ME1CLCA5Nk1CIGV0Yy5cbiAgICAgIHBhcnRTaXplICs9IDE2ICogMTAyNCAqIDEwMjRcbiAgICB9XG4gIH1cblxuICAvKipcbiAgICogVXBsb2FkcyB0aGUgb2JqZWN0IHVzaW5nIGNvbnRlbnRzIGZyb20gYSBmaWxlXG4gICAqL1xuICBhc3luYyBmUHV0T2JqZWN0KGJ1Y2tldE5hbWU6IHN0cmluZywgb2JqZWN0TmFtZTogc3RyaW5nLCBmaWxlUGF0aDogc3RyaW5nLCBtZXRhRGF0YT86IE9iamVjdE1ldGFEYXRhKSB7XG4gICAgaWYgKCFpc1ZhbGlkQnVja2V0TmFtZShidWNrZXROYW1lKSkge1xuICAgICAgdGhyb3cgbmV3IGVycm9ycy5JbnZhbGlkQnVja2V0TmFtZUVycm9yKCdJbnZhbGlkIGJ1Y2tldCBuYW1lOiAnICsgYnVja2V0TmFtZSlcbiAgICB9XG4gICAgaWYgKCFpc1ZhbGlkT2JqZWN0TmFtZShvYmplY3ROYW1lKSkge1xuICAgICAgdGhyb3cgbmV3IGVycm9ycy5JbnZhbGlkT2JqZWN0TmFtZUVycm9yKGBJbnZhbGlkIG9iamVjdCBuYW1lOiAke29iamVjdE5hbWV9YClcbiAgICB9XG5cbiAgICBpZiAoIWlzU3RyaW5nKGZpbGVQYXRoKSkge1xuICAgICAgdGhyb3cgbmV3IFR5cGVFcnJvcignZmlsZVBhdGggc2hvdWxkIGJlIG9mIHR5cGUgXCJzdHJpbmdcIicpXG4gICAgfVxuICAgIGlmIChtZXRhRGF0YSAmJiAhaXNPYmplY3QobWV0YURhdGEpKSB7XG4gICAgICB0aHJvdyBuZXcgVHlwZUVycm9yKCdtZXRhRGF0YSBzaG91bGQgYmUgb2YgdHlwZSBcIm9iamVjdFwiJylcbiAgICB9XG5cbiAgICAvLyBJbnNlcnRzIGNvcnJlY3QgYGNvbnRlbnQtdHlwZWAgYXR0cmlidXRlIGJhc2VkIG9uIG1ldGFEYXRhIGFuZCBmaWxlUGF0aFxuICAgIG1ldGFEYXRhID0gaW5zZXJ0Q29udGVudFR5cGUobWV0YURhdGEgfHwge30sIGZpbGVQYXRoKVxuICAgIGNvbnN0IHN0YXQgPSBhd2FpdCBmc3Auc3RhdChmaWxlUGF0aClcbiAgICByZXR1cm4gYXdhaXQgdGhpcy5wdXRPYmplY3QoYnVja2V0TmFtZSwgb2JqZWN0TmFtZSwgZnMuY3JlYXRlUmVhZFN0cmVhbShmaWxlUGF0aCksIHN0YXQuc2l6ZSwgbWV0YURhdGEpXG4gIH1cblxuICAvKipcbiAgICogIFVwbG9hZGluZyBhIHN0cmVhbSwgXCJCdWZmZXJcIiBvciBcInN0cmluZ1wiLlxuICAgKiAgSXQncyByZWNvbW1lbmRlZCB0byBwYXNzIGBzaXplYCBhcmd1bWVudCB3aXRoIHN0cmVhbS5cbiAgICovXG4gIGFzeW5jIHB1dE9iamVjdChcbiAgICBidWNrZXROYW1lOiBzdHJpbmcsXG4gICAgb2JqZWN0TmFtZTogc3RyaW5nLFxuICAgIHN0cmVhbTogc3RyZWFtLlJlYWRhYmxlIHwgQnVmZmVyIHwgc3RyaW5nLFxuICAgIHNpemU/OiBudW1iZXIsXG4gICAgbWV0YURhdGE/OiBJdGVtQnVja2V0TWV0YWRhdGEsXG4gICk6IFByb21pc2U8VXBsb2FkZWRPYmplY3RJbmZvPiB7XG4gICAgaWYgKCFpc1ZhbGlkQnVja2V0TmFtZShidWNrZXROYW1lKSkge1xuICAgICAgdGhyb3cgbmV3IGVycm9ycy5JbnZhbGlkQnVja2V0TmFtZUVycm9yKGBJbnZhbGlkIGJ1Y2tldCBuYW1lOiAke2J1Y2tldE5hbWV9YClcbiAgICB9XG4gICAgaWYgKCFpc1ZhbGlkT2JqZWN0TmFtZShvYmplY3ROYW1lKSkge1xuICAgICAgdGhyb3cgbmV3IGVycm9ycy5JbnZhbGlkT2JqZWN0TmFtZUVycm9yKGBJbnZhbGlkIG9iamVjdCBuYW1lOiAke29iamVjdE5hbWV9YClcbiAgICB9XG5cbiAgICAvLyBXZSdsbCBuZWVkIHRvIHNoaWZ0IGFyZ3VtZW50cyB0byB0aGUgbGVmdCBiZWNhdXNlIG9mIG1ldGFEYXRhXG4gICAgLy8gYW5kIHNpemUgYmVpbmcgb3B0aW9uYWwuXG4gICAgaWYgKGlzT2JqZWN0KHNpemUpKSB7XG4gICAgICBtZXRhRGF0YSA9IHNpemVcbiAgICB9XG4gICAgLy8gRW5zdXJlcyBNZXRhZGF0YSBoYXMgYXBwcm9wcmlhdGUgcHJlZml4IGZvciBBMyBBUElcbiAgICBjb25zdCBoZWFkZXJzID0gcHJlcGVuZFhBTVpNZXRhKG1ldGFEYXRhKVxuICAgIGlmICh0eXBlb2Ygc3RyZWFtID09PSAnc3RyaW5nJyB8fCBzdHJlYW0gaW5zdGFuY2VvZiBCdWZmZXIpIHtcbiAgICAgIC8vIEFkYXB0cyB0aGUgbm9uLXN0cmVhbSBpbnRlcmZhY2UgaW50byBhIHN0cmVhbS5cbiAgICAgIHNpemUgPSBzdHJlYW0ubGVuZ3RoXG4gICAgICBzdHJlYW0gPSByZWFkYWJsZVN0cmVhbShzdHJlYW0pXG4gICAgfSBlbHNlIGlmICghaXNSZWFkYWJsZVN0cmVhbShzdHJlYW0pKSB7XG4gICAgICB0aHJvdyBuZXcgVHlwZUVycm9yKCd0aGlyZCBhcmd1bWVudCBzaG91bGQgYmUgb2YgdHlwZSBcInN0cmVhbS5SZWFkYWJsZVwiIG9yIFwiQnVmZmVyXCIgb3IgXCJzdHJpbmdcIicpXG4gICAgfVxuXG4gICAgaWYgKGlzTnVtYmVyKHNpemUpICYmIHNpemUgPCAwKSB7XG4gICAgICB0aHJvdyBuZXcgZXJyb3JzLkludmFsaWRBcmd1bWVudEVycm9yKGBzaXplIGNhbm5vdCBiZSBuZWdhdGl2ZSwgZ2l2ZW4gc2l6ZTogJHtzaXplfWApXG4gICAgfVxuXG4gICAgLy8gR2V0IHRoZSBwYXJ0IHNpemUgYW5kIGZvcndhcmQgdGhhdCB0byB0aGUgQmxvY2tTdHJlYW0uIERlZmF1bHQgdG8gdGhlXG4gICAgLy8gbGFyZ2VzdCBibG9jayBzaXplIHBvc3NpYmxlIGlmIG5lY2Vzc2FyeS5cbiAgICBpZiAoIWlzTnVtYmVyKHNpemUpKSB7XG4gICAgICBzaXplID0gdGhpcy5tYXhPYmplY3RTaXplXG4gICAgfVxuXG4gICAgLy8gR2V0IHRoZSBwYXJ0IHNpemUgYW5kIGZvcndhcmQgdGhhdCB0byB0aGUgQmxvY2tTdHJlYW0uIERlZmF1bHQgdG8gdGhlXG4gICAgLy8gbGFyZ2VzdCBibG9jayBzaXplIHBvc3NpYmxlIGlmIG5lY2Vzc2FyeS5cbiAgICBpZiAoc2l6ZSA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICBjb25zdCBzdGF0U2l6ZSA9IGF3YWl0IGdldENvbnRlbnRMZW5ndGgoc3RyZWFtKVxuICAgICAgaWYgKHN0YXRTaXplICE9PSBudWxsKSB7XG4gICAgICAgIHNpemUgPSBzdGF0U2l6ZVxuICAgICAgfVxuICAgIH1cblxuICAgIGlmICghaXNOdW1iZXIoc2l6ZSkpIHtcbiAgICAgIC8vIEJhY2t3YXJkIGNvbXBhdGliaWxpdHlcbiAgICAgIHNpemUgPSB0aGlzLm1heE9iamVjdFNpemVcbiAgICB9XG4gICAgaWYgKHNpemUgPT09IDApIHtcbiAgICAgIHJldHVybiB0aGlzLnVwbG9hZEJ1ZmZlcihidWNrZXROYW1lLCBvYmplY3ROYW1lLCBoZWFkZXJzLCBCdWZmZXIuZnJvbSgnJykpXG4gICAgfVxuXG4gICAgY29uc3QgcGFydFNpemUgPSB0aGlzLmNhbGN1bGF0ZVBhcnRTaXplKHNpemUpXG4gICAgaWYgKHR5cGVvZiBzdHJlYW0gPT09ICdzdHJpbmcnIHx8IEJ1ZmZlci5pc0J1ZmZlcihzdHJlYW0pIHx8IHNpemUgPD0gcGFydFNpemUpIHtcbiAgICAgIGNvbnN0IGJ1ZiA9IGlzUmVhZGFibGVTdHJlYW0oc3RyZWFtKSA/IGF3YWl0IHJlYWRBc0J1ZmZlcihzdHJlYW0pIDogQnVmZmVyLmZyb20oc3RyZWFtKVxuICAgICAgcmV0dXJuIHRoaXMudXBsb2FkQnVmZmVyKGJ1Y2tldE5hbWUsIG9iamVjdE5hbWUsIGhlYWRlcnMsIGJ1ZilcbiAgICB9XG5cbiAgICByZXR1cm4gdGhpcy51cGxvYWRTdHJlYW0oYnVja2V0TmFtZSwgb2JqZWN0TmFtZSwgaGVhZGVycywgc3RyZWFtLCBwYXJ0U2l6ZSlcbiAgfVxuXG4gIC8qKlxuICAgKiBtZXRob2QgdG8gdXBsb2FkIGJ1ZmZlciBpbiBvbmUgY2FsbFxuICAgKiBAcHJpdmF0ZVxuICAgKi9cbiAgcHJpdmF0ZSBhc3luYyB1cGxvYWRCdWZmZXIoXG4gICAgYnVja2V0TmFtZTogc3RyaW5nLFxuICAgIG9iamVjdE5hbWU6IHN0cmluZyxcbiAgICBoZWFkZXJzOiBSZXF1ZXN0SGVhZGVycyxcbiAgICBidWY6IEJ1ZmZlcixcbiAgKTogUHJvbWlzZTxVcGxvYWRlZE9iamVjdEluZm8+IHtcbiAgICBjb25zdCB7IG1kNXN1bSwgc2hhMjU2c3VtIH0gPSBoYXNoQmluYXJ5KGJ1ZiwgdGhpcy5lbmFibGVTSEEyNTYpXG4gICAgaGVhZGVyc1snQ29udGVudC1MZW5ndGgnXSA9IGJ1Zi5sZW5ndGhcbiAgICBpZiAoIXRoaXMuZW5hYmxlU0hBMjU2KSB7XG4gICAgICBoZWFkZXJzWydDb250ZW50LU1ENSddID0gbWQ1c3VtXG4gICAgfVxuICAgIGNvbnN0IHJlcyA9IGF3YWl0IHRoaXMubWFrZVJlcXVlc3RTdHJlYW1Bc3luYyhcbiAgICAgIHtcbiAgICAgICAgbWV0aG9kOiAnUFVUJyxcbiAgICAgICAgYnVja2V0TmFtZSxcbiAgICAgICAgb2JqZWN0TmFtZSxcbiAgICAgICAgaGVhZGVycyxcbiAgICAgIH0sXG4gICAgICBidWYsXG4gICAgICBzaGEyNTZzdW0sXG4gICAgICBbMjAwXSxcbiAgICAgICcnLFxuICAgIClcbiAgICBhd2FpdCBkcmFpblJlc3BvbnNlKHJlcylcbiAgICByZXR1cm4ge1xuICAgICAgZXRhZzogc2FuaXRpemVFVGFnKHJlcy5oZWFkZXJzLmV0YWcpLFxuICAgICAgdmVyc2lvbklkOiBnZXRWZXJzaW9uSWQocmVzLmhlYWRlcnMgYXMgUmVzcG9uc2VIZWFkZXIpLFxuICAgIH1cbiAgfVxuXG4gIC8qKlxuICAgKiB1cGxvYWQgc3RyZWFtIHdpdGggTXVsdGlwYXJ0VXBsb2FkXG4gICAqIEBwcml2YXRlXG4gICAqL1xuICBwcml2YXRlIGFzeW5jIHVwbG9hZFN0cmVhbShcbiAgICBidWNrZXROYW1lOiBzdHJpbmcsXG4gICAgb2JqZWN0TmFtZTogc3RyaW5nLFxuICAgIGhlYWRlcnM6IFJlcXVlc3RIZWFkZXJzLFxuICAgIGJvZHk6IHN0cmVhbS5SZWFkYWJsZSxcbiAgICBwYXJ0U2l6ZTogbnVtYmVyLFxuICApOiBQcm9taXNlPFVwbG9hZGVkT2JqZWN0SW5mbz4ge1xuICAgIC8vIEEgbWFwIG9mIHRoZSBwcmV2aW91c2x5IHVwbG9hZGVkIGNodW5rcywgZm9yIHJlc3VtaW5nIGEgZmlsZSB1cGxvYWQuIFRoaXNcbiAgICAvLyB3aWxsIGJlIG51bGwgaWYgd2UgYXJlbid0IHJlc3VtaW5nIGFuIHVwbG9hZC5cbiAgICBjb25zdCBvbGRQYXJ0czogUmVjb3JkPG51bWJlciwgUGFydD4gPSB7fVxuXG4gICAgLy8gS2VlcCB0cmFjayBvZiB0aGUgZXRhZ3MgZm9yIGFnZ3JlZ2F0aW5nIHRoZSBjaHVua3MgdG9nZXRoZXIgbGF0ZXIuIEVhY2hcbiAgICAvLyBldGFnIHJlcHJlc2VudHMgYSBzaW5nbGUgY2h1bmsgb2YgdGhlIGZpbGUuXG4gICAgY29uc3QgZVRhZ3M6IFBhcnRbXSA9IFtdXG5cbiAgICBjb25zdCBwcmV2aW91c1VwbG9hZElkID0gYXdhaXQgdGhpcy5maW5kVXBsb2FkSWQoYnVja2V0TmFtZSwgb2JqZWN0TmFtZSlcbiAgICBsZXQgdXBsb2FkSWQ6IHN0cmluZ1xuICAgIGlmICghcHJldmlvdXNVcGxvYWRJZCkge1xuICAgICAgdXBsb2FkSWQgPSBhd2FpdCB0aGlzLmluaXRpYXRlTmV3TXVsdGlwYXJ0VXBsb2FkKGJ1Y2tldE5hbWUsIG9iamVjdE5hbWUsIGhlYWRlcnMpXG4gICAgfSBlbHNlIHtcbiAgICAgIHVwbG9hZElkID0gcHJldmlvdXNVcGxvYWRJZFxuICAgICAgY29uc3Qgb2xkVGFncyA9IGF3YWl0IHRoaXMubGlzdFBhcnRzKGJ1Y2tldE5hbWUsIG9iamVjdE5hbWUsIHByZXZpb3VzVXBsb2FkSWQpXG4gICAgICBvbGRUYWdzLmZvckVhY2goKGUpID0+IHtcbiAgICAgICAgb2xkUGFydHNbZS5wYXJ0XSA9IGVcbiAgICAgIH0pXG4gICAgfVxuXG4gICAgY29uc3QgY2h1bmtpZXIgPSBuZXcgQmxvY2tTdHJlYW0yKHsgc2l6ZTogcGFydFNpemUsIHplcm9QYWRkaW5nOiBmYWxzZSB9KVxuXG4gICAgLy8gZXNsaW50LWRpc2FibGUtbmV4dC1saW5lIEB0eXBlc2NyaXB0LWVzbGludC9uby11bnVzZWQtdmFyc1xuICAgIGNvbnN0IFtfLCBvXSA9IGF3YWl0IFByb21pc2UuYWxsKFtcbiAgICAgIG5ldyBQcm9taXNlKChyZXNvbHZlLCByZWplY3QpID0+IHtcbiAgICAgICAgYm9keS5waXBlKGNodW5raWVyKS5vbignZXJyb3InLCByZWplY3QpXG4gICAgICAgIGNodW5raWVyLm9uKCdlbmQnLCByZXNvbHZlKS5vbignZXJyb3InLCByZWplY3QpXG4gICAgICB9KSxcbiAgICAgIChhc3luYyAoKSA9PiB7XG4gICAgICAgIGxldCBwYXJ0TnVtYmVyID0gMVxuXG4gICAgICAgIGZvciBhd2FpdCAoY29uc3QgY2h1bmsgb2YgY2h1bmtpZXIpIHtcbiAgICAgICAgICBjb25zdCBtZDUgPSBjcnlwdG8uY3JlYXRlSGFzaCgnbWQ1JykudXBkYXRlKGNodW5rKS5kaWdlc3QoKVxuXG4gICAgICAgICAgY29uc3Qgb2xkUGFydCA9IG9sZFBhcnRzW3BhcnROdW1iZXJdXG4gICAgICAgICAgaWYgKG9sZFBhcnQpIHtcbiAgICAgICAgICAgIGlmIChvbGRQYXJ0LmV0YWcgPT09IG1kNS50b1N0cmluZygnaGV4JykpIHtcbiAgICAgICAgICAgICAgZVRhZ3MucHVzaCh7IHBhcnQ6IHBhcnROdW1iZXIsIGV0YWc6IG9sZFBhcnQuZXRhZyB9KVxuICAgICAgICAgICAgICBwYXJ0TnVtYmVyKytcbiAgICAgICAgICAgICAgY29udGludWVcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9XG5cbiAgICAgICAgICBwYXJ0TnVtYmVyKytcblxuICAgICAgICAgIC8vIG5vdyBzdGFydCB0byB1cGxvYWQgbWlzc2luZyBwYXJ0XG4gICAgICAgICAgY29uc3Qgb3B0aW9uczogUmVxdWVzdE9wdGlvbiA9IHtcbiAgICAgICAgICAgIG1ldGhvZDogJ1BVVCcsXG4gICAgICAgICAgICBxdWVyeTogcXMuc3RyaW5naWZ5KHsgcGFydE51bWJlciwgdXBsb2FkSWQgfSksXG4gICAgICAgICAgICBoZWFkZXJzOiB7XG4gICAgICAgICAgICAgICdDb250ZW50LUxlbmd0aCc6IGNodW5rLmxlbmd0aCxcbiAgICAgICAgICAgICAgJ0NvbnRlbnQtTUQ1JzogbWQ1LnRvU3RyaW5nKCdiYXNlNjQnKSxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgICBidWNrZXROYW1lLFxuICAgICAgICAgICAgb2JqZWN0TmFtZSxcbiAgICAgICAgICB9XG5cbiAgICAgICAgICBjb25zdCByZXNwb25zZSA9IGF3YWl0IHRoaXMubWFrZVJlcXVlc3RBc3luY09taXQob3B0aW9ucywgY2h1bmspXG5cbiAgICAgICAgICBsZXQgZXRhZyA9IHJlc3BvbnNlLmhlYWRlcnMuZXRhZ1xuICAgICAgICAgIGlmIChldGFnKSB7XG4gICAgICAgICAgICBldGFnID0gZXRhZy5yZXBsYWNlKC9eXCIvLCAnJykucmVwbGFjZSgvXCIkLywgJycpXG4gICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGV0YWcgPSAnJ1xuICAgICAgICAgIH1cblxuICAgICAgICAgIGVUYWdzLnB1c2goeyBwYXJ0OiBwYXJ0TnVtYmVyLCBldGFnIH0pXG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gYXdhaXQgdGhpcy5jb21wbGV0ZU11bHRpcGFydFVwbG9hZChidWNrZXROYW1lLCBvYmplY3ROYW1lLCB1cGxvYWRJZCwgZVRhZ3MpXG4gICAgICB9KSgpLFxuICAgIF0pXG5cbiAgICByZXR1cm4gb1xuICB9XG5cbiAgYXN5bmMgcmVtb3ZlQnVja2V0UmVwbGljYXRpb24oYnVja2V0TmFtZTogc3RyaW5nKTogUHJvbWlzZTx2b2lkPlxuICByZW1vdmVCdWNrZXRSZXBsaWNhdGlvbihidWNrZXROYW1lOiBzdHJpbmcsIGNhbGxiYWNrOiBOb1Jlc3VsdENhbGxiYWNrKTogdm9pZFxuICBhc3luYyByZW1vdmVCdWNrZXRSZXBsaWNhdGlvbihidWNrZXROYW1lOiBzdHJpbmcpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBpZiAoIWlzVmFsaWRCdWNrZXROYW1lKGJ1Y2tldE5hbWUpKSB7XG4gICAgICB0aHJvdyBuZXcgZXJyb3JzLkludmFsaWRCdWNrZXROYW1lRXJyb3IoJ0ludmFsaWQgYnVja2V0IG5hbWU6ICcgKyBidWNrZXROYW1lKVxuICAgIH1cbiAgICBjb25zdCBtZXRob2QgPSAnREVMRVRFJ1xuICAgIGNvbnN0IHF1ZXJ5ID0gJ3JlcGxpY2F0aW9uJ1xuICAgIGF3YWl0IHRoaXMubWFrZVJlcXVlc3RBc3luY09taXQoeyBtZXRob2QsIGJ1Y2tldE5hbWUsIHF1ZXJ5IH0sICcnLCBbMjAwLCAyMDRdLCAnJylcbiAgfVxuXG4gIHNldEJ1Y2tldFJlcGxpY2F0aW9uKGJ1Y2tldE5hbWU6IHN0cmluZywgcmVwbGljYXRpb25Db25maWc6IFJlcGxpY2F0aW9uQ29uZmlnT3B0cyk6IHZvaWRcbiAgYXN5bmMgc2V0QnVja2V0UmVwbGljYXRpb24oYnVja2V0TmFtZTogc3RyaW5nLCByZXBsaWNhdGlvbkNvbmZpZzogUmVwbGljYXRpb25Db25maWdPcHRzKTogUHJvbWlzZTx2b2lkPlxuICBhc3luYyBzZXRCdWNrZXRSZXBsaWNhdGlvbihidWNrZXROYW1lOiBzdHJpbmcsIHJlcGxpY2F0aW9uQ29uZmlnOiBSZXBsaWNhdGlvbkNvbmZpZ09wdHMpIHtcbiAgICBpZiAoIWlzVmFsaWRCdWNrZXROYW1lKGJ1Y2tldE5hbWUpKSB7XG4gICAgICB0aHJvdyBuZXcgZXJyb3JzLkludmFsaWRCdWNrZXROYW1lRXJyb3IoJ0ludmFsaWQgYnVja2V0IG5hbWU6ICcgKyBidWNrZXROYW1lKVxuICAgIH1cbiAgICBpZiAoIWlzT2JqZWN0KHJlcGxpY2F0aW9uQ29uZmlnKSkge1xuICAgICAgdGhyb3cgbmV3IGVycm9ycy5JbnZhbGlkQXJndW1lbnRFcnJvcigncmVwbGljYXRpb25Db25maWcgc2hvdWxkIGJlIG9mIHR5cGUgXCJvYmplY3RcIicpXG4gICAgfSBlbHNlIHtcbiAgICAgIGlmIChfLmlzRW1wdHkocmVwbGljYXRpb25Db25maWcucm9sZSkpIHtcbiAgICAgICAgdGhyb3cgbmV3IGVycm9ycy5JbnZhbGlkQXJndW1lbnRFcnJvcignUm9sZSBjYW5ub3QgYmUgZW1wdHknKVxuICAgICAgfSBlbHNlIGlmIChyZXBsaWNhdGlvbkNvbmZpZy5yb2xlICYmICFpc1N0cmluZyhyZXBsaWNhdGlvbkNvbmZpZy5yb2xlKSkge1xuICAgICAgICB0aHJvdyBuZXcgZXJyb3JzLkludmFsaWRBcmd1bWVudEVycm9yKCdJbnZhbGlkIHZhbHVlIGZvciByb2xlJywgcmVwbGljYXRpb25Db25maWcucm9sZSlcbiAgICAgIH1cbiAgICAgIGlmIChfLmlzRW1wdHkocmVwbGljYXRpb25Db25maWcucnVsZXMpKSB7XG4gICAgICAgIHRocm93IG5ldyBlcnJvcnMuSW52YWxpZEFyZ3VtZW50RXJyb3IoJ01pbmltdW0gb25lIHJlcGxpY2F0aW9uIHJ1bGUgbXVzdCBiZSBzcGVjaWZpZWQnKVxuICAgICAgfVxuICAgIH1cbiAgICBjb25zdCBtZXRob2QgPSAnUFVUJ1xuICAgIGNvbnN0IHF1ZXJ5ID0gJ3JlcGxpY2F0aW9uJ1xuICAgIGNvbnN0IGhlYWRlcnM6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7fVxuXG4gICAgY29uc3QgcmVwbGljYXRpb25QYXJhbXNDb25maWcgPSB7XG4gICAgICBSZXBsaWNhdGlvbkNvbmZpZ3VyYXRpb246IHtcbiAgICAgICAgUm9sZTogcmVwbGljYXRpb25Db25maWcucm9sZSxcbiAgICAgICAgUnVsZTogcmVwbGljYXRpb25Db25maWcucnVsZXMsXG4gICAgICB9LFxuICAgIH1cblxuICAgIGNvbnN0IGJ1aWxkZXIgPSBuZXcgeG1sMmpzLkJ1aWxkZXIoeyByZW5kZXJPcHRzOiB7IHByZXR0eTogZmFsc2UgfSwgaGVhZGxlc3M6IHRydWUgfSlcbiAgICBjb25zdCBwYXlsb2FkID0gYnVpbGRlci5idWlsZE9iamVjdChyZXBsaWNhdGlvblBhcmFtc0NvbmZpZylcbiAgICBoZWFkZXJzWydDb250ZW50LU1ENSddID0gdG9NZDUocGF5bG9hZClcbiAgICBhd2FpdCB0aGlzLm1ha2VSZXF1ZXN0QXN5bmNPbWl0KHsgbWV0aG9kLCBidWNrZXROYW1lLCBxdWVyeSwgaGVhZGVycyB9LCBwYXlsb2FkKVxuICB9XG5cbiAgZ2V0QnVja2V0UmVwbGljYXRpb24oYnVja2V0TmFtZTogc3RyaW5nKTogdm9pZFxuICBhc3luYyBnZXRCdWNrZXRSZXBsaWNhdGlvbihidWNrZXROYW1lOiBzdHJpbmcpOiBQcm9taXNlPFJlcGxpY2F0aW9uQ29uZmlnPlxuICBhc3luYyBnZXRCdWNrZXRSZXBsaWNhdGlvbihidWNrZXROYW1lOiBzdHJpbmcpIHtcbiAgICBpZiAoIWlzVmFsaWRCdWNrZXROYW1lKGJ1Y2tldE5hbWUpKSB7XG4gICAgICB0aHJvdyBuZXcgZXJyb3JzLkludmFsaWRCdWNrZXROYW1lRXJyb3IoJ0ludmFsaWQgYnVja2V0IG5hbWU6ICcgKyBidWNrZXROYW1lKVxuICAgIH1cbiAgICBjb25zdCBtZXRob2QgPSAnR0VUJ1xuICAgIGNvbnN0IHF1ZXJ5ID0gJ3JlcGxpY2F0aW9uJ1xuXG4gICAgY29uc3QgaHR0cFJlcyA9IGF3YWl0IHRoaXMubWFrZVJlcXVlc3RBc3luYyh7IG1ldGhvZCwgYnVja2V0TmFtZSwgcXVlcnkgfSwgJycsIFsyMDAsIDIwNF0pXG4gICAgY29uc3QgeG1sUmVzdWx0ID0gYXdhaXQgcmVhZEFzU3RyaW5nKGh0dHBSZXMpXG4gICAgcmV0dXJuIHhtbFBhcnNlcnMucGFyc2VSZXBsaWNhdGlvbkNvbmZpZyh4bWxSZXN1bHQpXG4gIH1cblxuICBnZXRPYmplY3RMZWdhbEhvbGQoXG4gICAgYnVja2V0TmFtZTogc3RyaW5nLFxuICAgIG9iamVjdE5hbWU6IHN0cmluZyxcbiAgICBnZXRPcHRzPzogR2V0T2JqZWN0TGVnYWxIb2xkT3B0aW9ucyxcbiAgICBjYWxsYmFjaz86IFJlc3VsdENhbGxiYWNrPExFR0FMX0hPTERfU1RBVFVTPixcbiAgKTogUHJvbWlzZTxMRUdBTF9IT0xEX1NUQVRVUz5cbiAgYXN5bmMgZ2V0T2JqZWN0TGVnYWxIb2xkKFxuICAgIGJ1Y2tldE5hbWU6IHN0cmluZyxcbiAgICBvYmplY3ROYW1lOiBzdHJpbmcsXG4gICAgZ2V0T3B0cz86IEdldE9iamVjdExlZ2FsSG9sZE9wdGlvbnMsXG4gICk6IFByb21pc2U8TEVHQUxfSE9MRF9TVEFUVVM+IHtcbiAgICBpZiAoIWlzVmFsaWRCdWNrZXROYW1lKGJ1Y2tldE5hbWUpKSB7XG4gICAgICB0aHJvdyBuZXcgZXJyb3JzLkludmFsaWRCdWNrZXROYW1lRXJyb3IoJ0ludmFsaWQgYnVja2V0IG5hbWU6ICcgKyBidWNrZXROYW1lKVxuICAgIH1cbiAgICBpZiAoIWlzVmFsaWRPYmplY3ROYW1lKG9iamVjdE5hbWUpKSB7XG4gICAgICB0aHJvdyBuZXcgZXJyb3JzLkludmFsaWRPYmplY3ROYW1lRXJyb3IoYEludmFsaWQgb2JqZWN0IG5hbWU6ICR7b2JqZWN0TmFtZX1gKVxuICAgIH1cblxuICAgIGlmIChnZXRPcHRzKSB7XG4gICAgICBpZiAoIWlzT2JqZWN0KGdldE9wdHMpKSB7XG4gICAgICAgIHRocm93IG5ldyBUeXBlRXJyb3IoJ2dldE9wdHMgc2hvdWxkIGJlIG9mIHR5cGUgXCJPYmplY3RcIicpXG4gICAgICB9IGVsc2UgaWYgKE9iamVjdC5rZXlzKGdldE9wdHMpLmxlbmd0aCA+IDAgJiYgZ2V0T3B0cy52ZXJzaW9uSWQgJiYgIWlzU3RyaW5nKGdldE9wdHMudmVyc2lvbklkKSkge1xuICAgICAgICB0aHJvdyBuZXcgVHlwZUVycm9yKCd2ZXJzaW9uSWQgc2hvdWxkIGJlIG9mIHR5cGUgc3RyaW5nLjonLCBnZXRPcHRzLnZlcnNpb25JZClcbiAgICAgIH1cbiAgICB9XG5cbiAgICBjb25zdCBtZXRob2QgPSAnR0VUJ1xuICAgIGxldCBxdWVyeSA9ICdsZWdhbC1ob2xkJ1xuXG4gICAgaWYgKGdldE9wdHM/LnZlcnNpb25JZCkge1xuICAgICAgcXVlcnkgKz0gYCZ2ZXJzaW9uSWQ9JHtnZXRPcHRzLnZlcnNpb25JZH1gXG4gICAgfVxuXG4gICAgY29uc3QgaHR0cFJlcyA9IGF3YWl0IHRoaXMubWFrZVJlcXVlc3RBc3luYyh7IG1ldGhvZCwgYnVja2V0TmFtZSwgb2JqZWN0TmFtZSwgcXVlcnkgfSwgJycsIFsyMDBdKVxuICAgIGNvbnN0IHN0clJlcyA9IGF3YWl0IHJlYWRBc1N0cmluZyhodHRwUmVzKVxuICAgIHJldHVybiBwYXJzZU9iamVjdExlZ2FsSG9sZENvbmZpZyhzdHJSZXMpXG4gIH1cblxuICBzZXRPYmplY3RMZWdhbEhvbGQoYnVja2V0TmFtZTogc3RyaW5nLCBvYmplY3ROYW1lOiBzdHJpbmcsIHNldE9wdHM/OiBQdXRPYmplY3RMZWdhbEhvbGRPcHRpb25zKTogdm9pZFxuICBhc3luYyBzZXRPYmplY3RMZWdhbEhvbGQoXG4gICAgYnVja2V0TmFtZTogc3RyaW5nLFxuICAgIG9iamVjdE5hbWU6IHN0cmluZyxcbiAgICBzZXRPcHRzID0ge1xuICAgICAgc3RhdHVzOiBMRUdBTF9IT0xEX1NUQVRVUy5FTkFCTEVELFxuICAgIH0gYXMgUHV0T2JqZWN0TGVnYWxIb2xkT3B0aW9ucyxcbiAgKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgaWYgKCFpc1ZhbGlkQnVja2V0TmFtZShidWNrZXROYW1lKSkge1xuICAgICAgdGhyb3cgbmV3IGVycm9ycy5JbnZhbGlkQnVja2V0TmFtZUVycm9yKCdJbnZhbGlkIGJ1Y2tldCBuYW1lOiAnICsgYnVja2V0TmFtZSlcbiAgICB9XG4gICAgaWYgKCFpc1ZhbGlkT2JqZWN0TmFtZShvYmplY3ROYW1lKSkge1xuICAgICAgdGhyb3cgbmV3IGVycm9ycy5JbnZhbGlkT2JqZWN0TmFtZUVycm9yKGBJbnZhbGlkIG9iamVjdCBuYW1lOiAke29iamVjdE5hbWV9YClcbiAgICB9XG5cbiAgICBpZiAoIWlzT2JqZWN0KHNldE9wdHMpKSB7XG4gICAgICB0aHJvdyBuZXcgVHlwZUVycm9yKCdzZXRPcHRzIHNob3VsZCBiZSBvZiB0eXBlIFwiT2JqZWN0XCInKVxuICAgIH0gZWxzZSB7XG4gICAgICBpZiAoIVtMRUdBTF9IT0xEX1NUQVRVUy5FTkFCTEVELCBMRUdBTF9IT0xEX1NUQVRVUy5ESVNBQkxFRF0uaW5jbHVkZXMoc2V0T3B0cz8uc3RhdHVzKSkge1xuICAgICAgICB0aHJvdyBuZXcgVHlwZUVycm9yKCdJbnZhbGlkIHN0YXR1czogJyArIHNldE9wdHMuc3RhdHVzKVxuICAgICAgfVxuICAgICAgaWYgKHNldE9wdHMudmVyc2lvbklkICYmICFzZXRPcHRzLnZlcnNpb25JZC5sZW5ndGgpIHtcbiAgICAgICAgdGhyb3cgbmV3IFR5cGVFcnJvcigndmVyc2lvbklkIHNob3VsZCBiZSBvZiB0eXBlIHN0cmluZy46JyArIHNldE9wdHMudmVyc2lvbklkKVxuICAgICAgfVxuICAgIH1cblxuICAgIGNvbnN0IG1ldGhvZCA9ICdQVVQnXG4gICAgbGV0IHF1ZXJ5ID0gJ2xlZ2FsLWhvbGQnXG5cbiAgICBpZiAoc2V0T3B0cy52ZXJzaW9uSWQpIHtcbiAgICAgIHF1ZXJ5ICs9IGAmdmVyc2lvbklkPSR7c2V0T3B0cy52ZXJzaW9uSWR9YFxuICAgIH1cblxuICAgIGNvbnN0IGNvbmZpZyA9IHtcbiAgICAgIFN0YXR1czogc2V0T3B0cy5zdGF0dXMsXG4gICAgfVxuXG4gICAgY29uc3QgYnVpbGRlciA9IG5ldyB4bWwyanMuQnVpbGRlcih7IHJvb3ROYW1lOiAnTGVnYWxIb2xkJywgcmVuZGVyT3B0czogeyBwcmV0dHk6IGZhbHNlIH0sIGhlYWRsZXNzOiB0cnVlIH0pXG4gICAgY29uc3QgcGF5bG9hZCA9IGJ1aWxkZXIuYnVpbGRPYmplY3QoY29uZmlnKVxuICAgIGNvbnN0IGhlYWRlcnM6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7fVxuICAgIGhlYWRlcnNbJ0NvbnRlbnQtTUQ1J10gPSB0b01kNShwYXlsb2FkKVxuXG4gICAgYXdhaXQgdGhpcy5tYWtlUmVxdWVzdEFzeW5jT21pdCh7IG1ldGhvZCwgYnVja2V0TmFtZSwgb2JqZWN0TmFtZSwgcXVlcnksIGhlYWRlcnMgfSwgcGF5bG9hZClcbiAgfVxuXG4gIC8qKlxuICAgKiBHZXQgVGFncyBhc3NvY2lhdGVkIHdpdGggYSBCdWNrZXRcbiAgICovXG4gIGFzeW5jIGdldEJ1Y2tldFRhZ2dpbmcoYnVja2V0TmFtZTogc3RyaW5nKTogUHJvbWlzZTxUYWdbXT4ge1xuICAgIGlmICghaXNWYWxpZEJ1Y2tldE5hbWUoYnVja2V0TmFtZSkpIHtcbiAgICAgIHRocm93IG5ldyBlcnJvcnMuSW52YWxpZEJ1Y2tldE5hbWVFcnJvcihgSW52YWxpZCBidWNrZXQgbmFtZTogJHtidWNrZXROYW1lfWApXG4gICAgfVxuXG4gICAgY29uc3QgbWV0aG9kID0gJ0dFVCdcbiAgICBjb25zdCBxdWVyeSA9ICd0YWdnaW5nJ1xuICAgIGNvbnN0IHJlcXVlc3RPcHRpb25zID0geyBtZXRob2QsIGJ1Y2tldE5hbWUsIHF1ZXJ5IH1cblxuICAgIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgdGhpcy5tYWtlUmVxdWVzdEFzeW5jKHJlcXVlc3RPcHRpb25zKVxuICAgIGNvbnN0IGJvZHkgPSBhd2FpdCByZWFkQXNTdHJpbmcocmVzcG9uc2UpXG4gICAgcmV0dXJuIHhtbFBhcnNlcnMucGFyc2VUYWdnaW5nKGJvZHkpXG4gIH1cblxuICAvKipcbiAgICogIEdldCB0aGUgdGFncyBhc3NvY2lhdGVkIHdpdGggYSBidWNrZXQgT1IgYW4gb2JqZWN0XG4gICAqL1xuICBhc3luYyBnZXRPYmplY3RUYWdnaW5nKGJ1Y2tldE5hbWU6IHN0cmluZywgb2JqZWN0TmFtZTogc3RyaW5nLCBnZXRPcHRzPzogR2V0T2JqZWN0T3B0cyk6IFByb21pc2U8VGFnW10+IHtcbiAgICBjb25zdCBtZXRob2QgPSAnR0VUJ1xuICAgIGxldCBxdWVyeSA9ICd0YWdnaW5nJ1xuXG4gICAgaWYgKCFpc1ZhbGlkQnVja2V0TmFtZShidWNrZXROYW1lKSkge1xuICAgICAgdGhyb3cgbmV3IGVycm9ycy5JbnZhbGlkQnVja2V0TmFtZUVycm9yKCdJbnZhbGlkIGJ1Y2tldCBuYW1lOiAnICsgYnVja2V0TmFtZSlcbiAgICB9XG4gICAgaWYgKCFpc1ZhbGlkT2JqZWN0TmFtZShvYmplY3ROYW1lKSkge1xuICAgICAgdGhyb3cgbmV3IGVycm9ycy5JbnZhbGlkQnVja2V0TmFtZUVycm9yKCdJbnZhbGlkIG9iamVjdCBuYW1lOiAnICsgb2JqZWN0TmFtZSlcbiAgICB9XG4gICAgaWYgKGdldE9wdHMgJiYgIWlzT2JqZWN0KGdldE9wdHMpKSB7XG4gICAgICB0aHJvdyBuZXcgZXJyb3JzLkludmFsaWRBcmd1bWVudEVycm9yKCdnZXRPcHRzIHNob3VsZCBiZSBvZiB0eXBlIFwib2JqZWN0XCInKVxuICAgIH1cblxuICAgIGlmIChnZXRPcHRzICYmIGdldE9wdHMudmVyc2lvbklkKSB7XG4gICAgICBxdWVyeSA9IGAke3F1ZXJ5fSZ2ZXJzaW9uSWQ9JHtnZXRPcHRzLnZlcnNpb25JZH1gXG4gICAgfVxuICAgIGNvbnN0IHJlcXVlc3RPcHRpb25zOiBSZXF1ZXN0T3B0aW9uID0geyBtZXRob2QsIGJ1Y2tldE5hbWUsIHF1ZXJ5IH1cbiAgICBpZiAob2JqZWN0TmFtZSkge1xuICAgICAgcmVxdWVzdE9wdGlvbnNbJ29iamVjdE5hbWUnXSA9IG9iamVjdE5hbWVcbiAgICB9XG5cbiAgICBjb25zdCByZXNwb25zZSA9IGF3YWl0IHRoaXMubWFrZVJlcXVlc3RBc3luYyhyZXF1ZXN0T3B0aW9ucylcbiAgICBjb25zdCBib2R5ID0gYXdhaXQgcmVhZEFzU3RyaW5nKHJlc3BvbnNlKVxuICAgIHJldHVybiB4bWxQYXJzZXJzLnBhcnNlVGFnZ2luZyhib2R5KVxuICB9XG5cbiAgLyoqXG4gICAqICBTZXQgdGhlIHBvbGljeSBvbiBhIGJ1Y2tldCBvciBhbiBvYmplY3QgcHJlZml4LlxuICAgKi9cbiAgYXN5bmMgc2V0QnVja2V0UG9saWN5KGJ1Y2tldE5hbWU6IHN0cmluZywgcG9saWN5OiBzdHJpbmcpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICAvLyBWYWxpZGF0ZSBhcmd1bWVudHMuXG4gICAgaWYgKCFpc1ZhbGlkQnVja2V0TmFtZShidWNrZXROYW1lKSkge1xuICAgICAgdGhyb3cgbmV3IGVycm9ycy5JbnZhbGlkQnVja2V0TmFtZUVycm9yKGBJbnZhbGlkIGJ1Y2tldCBuYW1lOiAke2J1Y2tldE5hbWV9YClcbiAgICB9XG4gICAgaWYgKCFpc1N0cmluZyhwb2xpY3kpKSB7XG4gICAgICB0aHJvdyBuZXcgZXJyb3JzLkludmFsaWRCdWNrZXRQb2xpY3lFcnJvcihgSW52YWxpZCBidWNrZXQgcG9saWN5OiAke3BvbGljeX0gLSBtdXN0IGJlIFwic3RyaW5nXCJgKVxuICAgIH1cblxuICAgIGNvbnN0IHF1ZXJ5ID0gJ3BvbGljeSdcblxuICAgIGxldCBtZXRob2QgPSAnREVMRVRFJ1xuICAgIGlmIChwb2xpY3kpIHtcbiAgICAgIG1ldGhvZCA9ICdQVVQnXG4gICAgfVxuXG4gICAgYXdhaXQgdGhpcy5tYWtlUmVxdWVzdEFzeW5jT21pdCh7IG1ldGhvZCwgYnVja2V0TmFtZSwgcXVlcnkgfSwgcG9saWN5LCBbMjA0XSwgJycpXG4gIH1cblxuICAvKipcbiAgICogR2V0IHRoZSBwb2xpY3kgb24gYSBidWNrZXQgb3IgYW4gb2JqZWN0IHByZWZpeC5cbiAgICovXG4gIGFzeW5jIGdldEJ1Y2tldFBvbGljeShidWNrZXROYW1lOiBzdHJpbmcpOiBQcm9taXNlPHN0cmluZz4ge1xuICAgIC8vIFZhbGlkYXRlIGFyZ3VtZW50cy5cbiAgICBpZiAoIWlzVmFsaWRCdWNrZXROYW1lKGJ1Y2tldE5hbWUpKSB7XG4gICAgICB0aHJvdyBuZXcgZXJyb3JzLkludmFsaWRCdWNrZXROYW1lRXJyb3IoYEludmFsaWQgYnVja2V0IG5hbWU6ICR7YnVja2V0TmFtZX1gKVxuICAgIH1cblxuICAgIGNvbnN0IG1ldGhvZCA9ICdHRVQnXG4gICAgY29uc3QgcXVlcnkgPSAncG9saWN5J1xuICAgIGNvbnN0IHJlcyA9IGF3YWl0IHRoaXMubWFrZVJlcXVlc3RBc3luYyh7IG1ldGhvZCwgYnVja2V0TmFtZSwgcXVlcnkgfSlcbiAgICByZXR1cm4gYXdhaXQgcmVhZEFzU3RyaW5nKHJlcylcbiAgfVxuXG4gIGFzeW5jIHB1dE9iamVjdFJldGVudGlvbihidWNrZXROYW1lOiBzdHJpbmcsIG9iamVjdE5hbWU6IHN0cmluZywgcmV0ZW50aW9uT3B0czogUmV0ZW50aW9uID0ge30pOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBpZiAoIWlzVmFsaWRCdWNrZXROYW1lKGJ1Y2tldE5hbWUpKSB7XG4gICAgICB0aHJvdyBuZXcgZXJyb3JzLkludmFsaWRCdWNrZXROYW1lRXJyb3IoYEludmFsaWQgYnVja2V0IG5hbWU6ICR7YnVja2V0TmFtZX1gKVxuICAgIH1cbiAgICBpZiAoIWlzVmFsaWRPYmplY3ROYW1lKG9iamVjdE5hbWUpKSB7XG4gICAgICB0aHJvdyBuZXcgZXJyb3JzLkludmFsaWRPYmplY3ROYW1lRXJyb3IoYEludmFsaWQgb2JqZWN0IG5hbWU6ICR7b2JqZWN0TmFtZX1gKVxuICAgIH1cbiAgICBpZiAoIWlzT2JqZWN0KHJldGVudGlvbk9wdHMpKSB7XG4gICAgICB0aHJvdyBuZXcgZXJyb3JzLkludmFsaWRBcmd1bWVudEVycm9yKCdyZXRlbnRpb25PcHRzIHNob3VsZCBiZSBvZiB0eXBlIFwib2JqZWN0XCInKVxuICAgIH0gZWxzZSB7XG4gICAgICBpZiAocmV0ZW50aW9uT3B0cy5nb3Zlcm5hbmNlQnlwYXNzICYmICFpc0Jvb2xlYW4ocmV0ZW50aW9uT3B0cy5nb3Zlcm5hbmNlQnlwYXNzKSkge1xuICAgICAgICB0aHJvdyBuZXcgZXJyb3JzLkludmFsaWRBcmd1bWVudEVycm9yKGBJbnZhbGlkIHZhbHVlIGZvciBnb3Zlcm5hbmNlQnlwYXNzOiAke3JldGVudGlvbk9wdHMuZ292ZXJuYW5jZUJ5cGFzc31gKVxuICAgICAgfVxuICAgICAgaWYgKFxuICAgICAgICByZXRlbnRpb25PcHRzLm1vZGUgJiZcbiAgICAgICAgIVtSRVRFTlRJT05fTU9ERVMuQ09NUExJQU5DRSwgUkVURU5USU9OX01PREVTLkdPVkVSTkFOQ0VdLmluY2x1ZGVzKHJldGVudGlvbk9wdHMubW9kZSlcbiAgICAgICkge1xuICAgICAgICB0aHJvdyBuZXcgZXJyb3JzLkludmFsaWRBcmd1bWVudEVycm9yKGBJbnZhbGlkIG9iamVjdCByZXRlbnRpb24gbW9kZTogJHtyZXRlbnRpb25PcHRzLm1vZGV9YClcbiAgICAgIH1cbiAgICAgIGlmIChyZXRlbnRpb25PcHRzLnJldGFpblVudGlsRGF0ZSAmJiAhaXNTdHJpbmcocmV0ZW50aW9uT3B0cy5yZXRhaW5VbnRpbERhdGUpKSB7XG4gICAgICAgIHRocm93IG5ldyBlcnJvcnMuSW52YWxpZEFyZ3VtZW50RXJyb3IoYEludmFsaWQgdmFsdWUgZm9yIHJldGFpblVudGlsRGF0ZTogJHtyZXRlbnRpb25PcHRzLnJldGFpblVudGlsRGF0ZX1gKVxuICAgICAgfVxuICAgICAgaWYgKHJldGVudGlvbk9wdHMudmVyc2lvbklkICYmICFpc1N0cmluZyhyZXRlbnRpb25PcHRzLnZlcnNpb25JZCkpIHtcbiAgICAgICAgdGhyb3cgbmV3IGVycm9ycy5JbnZhbGlkQXJndW1lbnRFcnJvcihgSW52YWxpZCB2YWx1ZSBmb3IgdmVyc2lvbklkOiAke3JldGVudGlvbk9wdHMudmVyc2lvbklkfWApXG4gICAgICB9XG4gICAgfVxuXG4gICAgY29uc3QgbWV0aG9kID0gJ1BVVCdcbiAgICBsZXQgcXVlcnkgPSAncmV0ZW50aW9uJ1xuXG4gICAgY29uc3QgaGVhZGVyczogUmVxdWVzdEhlYWRlcnMgPSB7fVxuICAgIGlmIChyZXRlbnRpb25PcHRzLmdvdmVybmFuY2VCeXBhc3MpIHtcbiAgICAgIGhlYWRlcnNbJ1gtQW16LUJ5cGFzcy1Hb3Zlcm5hbmNlLVJldGVudGlvbiddID0gdHJ1ZVxuICAgIH1cblxuICAgIGNvbnN0IGJ1aWxkZXIgPSBuZXcgeG1sMmpzLkJ1aWxkZXIoeyByb290TmFtZTogJ1JldGVudGlvbicsIHJlbmRlck9wdHM6IHsgcHJldHR5OiBmYWxzZSB9LCBoZWFkbGVzczogdHJ1ZSB9KVxuICAgIGNvbnN0IHBhcmFtczogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHt9XG5cbiAgICBpZiAocmV0ZW50aW9uT3B0cy5tb2RlKSB7XG4gICAgICBwYXJhbXMuTW9kZSA9IHJldGVudGlvbk9wdHMubW9kZVxuICAgIH1cbiAgICBpZiAocmV0ZW50aW9uT3B0cy5yZXRhaW5VbnRpbERhdGUpIHtcbiAgICAgIHBhcmFtcy5SZXRhaW5VbnRpbERhdGUgPSByZXRlbnRpb25PcHRzLnJldGFpblVudGlsRGF0ZVxuICAgIH1cbiAgICBpZiAocmV0ZW50aW9uT3B0cy52ZXJzaW9uSWQpIHtcbiAgICAgIHF1ZXJ5ICs9IGAmdmVyc2lvbklkPSR7cmV0ZW50aW9uT3B0cy52ZXJzaW9uSWR9YFxuICAgIH1cblxuICAgIGNvbnN0IHBheWxvYWQgPSBidWlsZGVyLmJ1aWxkT2JqZWN0KHBhcmFtcylcblxuICAgIGhlYWRlcnNbJ0NvbnRlbnQtTUQ1J10gPSB0b01kNShwYXlsb2FkKVxuICAgIGF3YWl0IHRoaXMubWFrZVJlcXVlc3RBc3luY09taXQoeyBtZXRob2QsIGJ1Y2tldE5hbWUsIG9iamVjdE5hbWUsIHF1ZXJ5LCBoZWFkZXJzIH0sIHBheWxvYWQsIFsyMDAsIDIwNF0pXG4gIH1cblxuICBnZXRPYmplY3RMb2NrQ29uZmlnKGJ1Y2tldE5hbWU6IHN0cmluZywgY2FsbGJhY2s6IFJlc3VsdENhbGxiYWNrPE9iamVjdExvY2tJbmZvPik6IHZvaWRcbiAgZ2V0T2JqZWN0TG9ja0NvbmZpZyhidWNrZXROYW1lOiBzdHJpbmcpOiB2b2lkXG4gIGFzeW5jIGdldE9iamVjdExvY2tDb25maWcoYnVja2V0TmFtZTogc3RyaW5nKTogUHJvbWlzZTxPYmplY3RMb2NrSW5mbz5cbiAgYXN5bmMgZ2V0T2JqZWN0TG9ja0NvbmZpZyhidWNrZXROYW1lOiBzdHJpbmcpIHtcbiAgICBpZiAoIWlzVmFsaWRCdWNrZXROYW1lKGJ1Y2tldE5hbWUpKSB7XG4gICAgICB0aHJvdyBuZXcgZXJyb3JzLkludmFsaWRCdWNrZXROYW1lRXJyb3IoJ0ludmFsaWQgYnVja2V0IG5hbWU6ICcgKyBidWNrZXROYW1lKVxuICAgIH1cbiAgICBjb25zdCBtZXRob2QgPSAnR0VUJ1xuICAgIGNvbnN0IHF1ZXJ5ID0gJ29iamVjdC1sb2NrJ1xuXG4gICAgY29uc3QgaHR0cFJlcyA9IGF3YWl0IHRoaXMubWFrZVJlcXVlc3RBc3luYyh7IG1ldGhvZCwgYnVja2V0TmFtZSwgcXVlcnkgfSlcbiAgICBjb25zdCB4bWxSZXN1bHQgPSBhd2FpdCByZWFkQXNTdHJpbmcoaHR0cFJlcylcbiAgICByZXR1cm4geG1sUGFyc2Vycy5wYXJzZU9iamVjdExvY2tDb25maWcoeG1sUmVzdWx0KVxuICB9XG5cbiAgc2V0T2JqZWN0TG9ja0NvbmZpZyhidWNrZXROYW1lOiBzdHJpbmcsIGxvY2tDb25maWdPcHRzOiBPbWl0PE9iamVjdExvY2tJbmZvLCAnb2JqZWN0TG9ja0VuYWJsZWQnPik6IHZvaWRcbiAgYXN5bmMgc2V0T2JqZWN0TG9ja0NvbmZpZyhcbiAgICBidWNrZXROYW1lOiBzdHJpbmcsXG4gICAgbG9ja0NvbmZpZ09wdHM6IE9taXQ8T2JqZWN0TG9ja0luZm8sICdvYmplY3RMb2NrRW5hYmxlZCc+LFxuICApOiBQcm9taXNlPHZvaWQ+XG4gIGFzeW5jIHNldE9iamVjdExvY2tDb25maWcoYnVja2V0TmFtZTogc3RyaW5nLCBsb2NrQ29uZmlnT3B0czogT21pdDxPYmplY3RMb2NrSW5mbywgJ29iamVjdExvY2tFbmFibGVkJz4pIHtcbiAgICBjb25zdCByZXRlbnRpb25Nb2RlcyA9IFtSRVRFTlRJT05fTU9ERVMuQ09NUExJQU5DRSwgUkVURU5USU9OX01PREVTLkdPVkVSTkFOQ0VdXG4gICAgY29uc3QgdmFsaWRVbml0cyA9IFtSRVRFTlRJT05fVkFMSURJVFlfVU5JVFMuREFZUywgUkVURU5USU9OX1ZBTElESVRZX1VOSVRTLllFQVJTXVxuXG4gICAgaWYgKCFpc1ZhbGlkQnVja2V0TmFtZShidWNrZXROYW1lKSkge1xuICAgICAgdGhyb3cgbmV3IGVycm9ycy5JbnZhbGlkQnVja2V0TmFtZUVycm9yKCdJbnZhbGlkIGJ1Y2tldCBuYW1lOiAnICsgYnVja2V0TmFtZSlcbiAgICB9XG5cbiAgICBpZiAobG9ja0NvbmZpZ09wdHMubW9kZSAmJiAhcmV0ZW50aW9uTW9kZXMuaW5jbHVkZXMobG9ja0NvbmZpZ09wdHMubW9kZSkpIHtcbiAgICAgIHRocm93IG5ldyBUeXBlRXJyb3IoYGxvY2tDb25maWdPcHRzLm1vZGUgc2hvdWxkIGJlIG9uZSBvZiAke3JldGVudGlvbk1vZGVzfWApXG4gICAgfVxuICAgIGlmIChsb2NrQ29uZmlnT3B0cy51bml0ICYmICF2YWxpZFVuaXRzLmluY2x1ZGVzKGxvY2tDb25maWdPcHRzLnVuaXQpKSB7XG4gICAgICB0aHJvdyBuZXcgVHlwZUVycm9yKGBsb2NrQ29uZmlnT3B0cy51bml0IHNob3VsZCBiZSBvbmUgb2YgJHt2YWxpZFVuaXRzfWApXG4gICAgfVxuICAgIGlmIChsb2NrQ29uZmlnT3B0cy52YWxpZGl0eSAmJiAhaXNOdW1iZXIobG9ja0NvbmZpZ09wdHMudmFsaWRpdHkpKSB7XG4gICAgICB0aHJvdyBuZXcgVHlwZUVycm9yKGBsb2NrQ29uZmlnT3B0cy52YWxpZGl0eSBzaG91bGQgYmUgYSBudW1iZXJgKVxuICAgIH1cblxuICAgIGNvbnN0IG1ldGhvZCA9ICdQVVQnXG4gICAgY29uc3QgcXVlcnkgPSAnb2JqZWN0LWxvY2snXG5cbiAgICBjb25zdCBjb25maWc6IE9iamVjdExvY2tDb25maWdQYXJhbSA9IHtcbiAgICAgIE9iamVjdExvY2tFbmFibGVkOiAnRW5hYmxlZCcsXG4gICAgfVxuICAgIGNvbnN0IGNvbmZpZ0tleXMgPSBPYmplY3Qua2V5cyhsb2NrQ29uZmlnT3B0cylcblxuICAgIGNvbnN0IGlzQWxsS2V5c1NldCA9IFsndW5pdCcsICdtb2RlJywgJ3ZhbGlkaXR5J10uZXZlcnkoKGxjaykgPT4gY29uZmlnS2V5cy5pbmNsdWRlcyhsY2spKVxuICAgIC8vIENoZWNrIGlmIGtleXMgYXJlIHByZXNlbnQgYW5kIGFsbCBrZXlzIGFyZSBwcmVzZW50LlxuICAgIGlmIChjb25maWdLZXlzLmxlbmd0aCA+IDApIHtcbiAgICAgIGlmICghaXNBbGxLZXlzU2V0KSB7XG4gICAgICAgIHRocm93IG5ldyBUeXBlRXJyb3IoXG4gICAgICAgICAgYGxvY2tDb25maWdPcHRzLm1vZGUsbG9ja0NvbmZpZ09wdHMudW5pdCxsb2NrQ29uZmlnT3B0cy52YWxpZGl0eSBhbGwgdGhlIHByb3BlcnRpZXMgc2hvdWxkIGJlIHNwZWNpZmllZC5gLFxuICAgICAgICApXG4gICAgICB9IGVsc2Uge1xuICAgICAgICBjb25maWcuUnVsZSA9IHtcbiAgICAgICAgICBEZWZhdWx0UmV0ZW50aW9uOiB7fSxcbiAgICAgICAgfVxuICAgICAgICBpZiAobG9ja0NvbmZpZ09wdHMubW9kZSkge1xuICAgICAgICAgIGNvbmZpZy5SdWxlLkRlZmF1bHRSZXRlbnRpb24uTW9kZSA9IGxvY2tDb25maWdPcHRzLm1vZGVcbiAgICAgICAgfVxuICAgICAgICBpZiAobG9ja0NvbmZpZ09wdHMudW5pdCA9PT0gUkVURU5USU9OX1ZBTElESVRZX1VOSVRTLkRBWVMpIHtcbiAgICAgICAgICBjb25maWcuUnVsZS5EZWZhdWx0UmV0ZW50aW9uLkRheXMgPSBsb2NrQ29uZmlnT3B0cy52YWxpZGl0eVxuICAgICAgICB9IGVsc2UgaWYgKGxvY2tDb25maWdPcHRzLnVuaXQgPT09IFJFVEVOVElPTl9WQUxJRElUWV9VTklUUy5ZRUFSUykge1xuICAgICAgICAgIGNvbmZpZy5SdWxlLkRlZmF1bHRSZXRlbnRpb24uWWVhcnMgPSBsb2NrQ29uZmlnT3B0cy52YWxpZGl0eVxuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuXG4gICAgY29uc3QgYnVpbGRlciA9IG5ldyB4bWwyanMuQnVpbGRlcih7XG4gICAgICByb290TmFtZTogJ09iamVjdExvY2tDb25maWd1cmF0aW9uJyxcbiAgICAgIHJlbmRlck9wdHM6IHsgcHJldHR5OiBmYWxzZSB9LFxuICAgICAgaGVhZGxlc3M6IHRydWUsXG4gICAgfSlcbiAgICBjb25zdCBwYXlsb2FkID0gYnVpbGRlci5idWlsZE9iamVjdChjb25maWcpXG5cbiAgICBjb25zdCBoZWFkZXJzOiBSZXF1ZXN0SGVhZGVycyA9IHt9XG4gICAgaGVhZGVyc1snQ29udGVudC1NRDUnXSA9IHRvTWQ1KHBheWxvYWQpXG5cbiAgICBhd2FpdCB0aGlzLm1ha2VSZXF1ZXN0QXN5bmNPbWl0KHsgbWV0aG9kLCBidWNrZXROYW1lLCBxdWVyeSwgaGVhZGVycyB9LCBwYXlsb2FkKVxuICB9XG5cbiAgYXN5bmMgZ2V0QnVja2V0VmVyc2lvbmluZyhidWNrZXROYW1lOiBzdHJpbmcpOiBQcm9taXNlPEJ1Y2tldFZlcnNpb25pbmdDb25maWd1cmF0aW9uPiB7XG4gICAgaWYgKCFpc1ZhbGlkQnVja2V0TmFtZShidWNrZXROYW1lKSkge1xuICAgICAgdGhyb3cgbmV3IGVycm9ycy5JbnZhbGlkQnVja2V0TmFtZUVycm9yKCdJbnZhbGlkIGJ1Y2tldCBuYW1lOiAnICsgYnVja2V0TmFtZSlcbiAgICB9XG4gICAgY29uc3QgbWV0aG9kID0gJ0dFVCdcbiAgICBjb25zdCBxdWVyeSA9ICd2ZXJzaW9uaW5nJ1xuXG4gICAgY29uc3QgaHR0cFJlcyA9IGF3YWl0IHRoaXMubWFrZVJlcXVlc3RBc3luYyh7IG1ldGhvZCwgYnVja2V0TmFtZSwgcXVlcnkgfSlcbiAgICBjb25zdCB4bWxSZXN1bHQgPSBhd2FpdCByZWFkQXNTdHJpbmcoaHR0cFJlcylcbiAgICByZXR1cm4gYXdhaXQgeG1sUGFyc2Vycy5wYXJzZUJ1Y2tldFZlcnNpb25pbmdDb25maWcoeG1sUmVzdWx0KVxuICB9XG5cbiAgYXN5bmMgc2V0QnVja2V0VmVyc2lvbmluZyhidWNrZXROYW1lOiBzdHJpbmcsIHZlcnNpb25Db25maWc6IEJ1Y2tldFZlcnNpb25pbmdDb25maWd1cmF0aW9uKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgaWYgKCFpc1ZhbGlkQnVja2V0TmFtZShidWNrZXROYW1lKSkge1xuICAgICAgdGhyb3cgbmV3IGVycm9ycy5JbnZhbGlkQnVja2V0TmFtZUVycm9yKCdJbnZhbGlkIGJ1Y2tldCBuYW1lOiAnICsgYnVja2V0TmFtZSlcbiAgICB9XG4gICAgaWYgKCFPYmplY3Qua2V5cyh2ZXJzaW9uQ29uZmlnKS5sZW5ndGgpIHtcbiAgICAgIHRocm93IG5ldyBlcnJvcnMuSW52YWxpZEFyZ3VtZW50RXJyb3IoJ3ZlcnNpb25Db25maWcgc2hvdWxkIGJlIG9mIHR5cGUgXCJvYmplY3RcIicpXG4gICAgfVxuXG4gICAgY29uc3QgbWV0aG9kID0gJ1BVVCdcbiAgICBjb25zdCBxdWVyeSA9ICd2ZXJzaW9uaW5nJ1xuICAgIGNvbnN0IGJ1aWxkZXIgPSBuZXcgeG1sMmpzLkJ1aWxkZXIoe1xuICAgICAgcm9vdE5hbWU6ICdWZXJzaW9uaW5nQ29uZmlndXJhdGlvbicsXG4gICAgICByZW5kZXJPcHRzOiB7IHByZXR0eTogZmFsc2UgfSxcbiAgICAgIGhlYWRsZXNzOiB0cnVlLFxuICAgIH0pXG4gICAgY29uc3QgcGF5bG9hZCA9IGJ1aWxkZXIuYnVpbGRPYmplY3QodmVyc2lvbkNvbmZpZylcblxuICAgIGF3YWl0IHRoaXMubWFrZVJlcXVlc3RBc3luY09taXQoeyBtZXRob2QsIGJ1Y2tldE5hbWUsIHF1ZXJ5IH0sIHBheWxvYWQpXG4gIH1cblxuICBwcml2YXRlIGFzeW5jIHNldFRhZ2dpbmcodGFnZ2luZ1BhcmFtczogUHV0VGFnZ2luZ1BhcmFtcyk6IFByb21pc2U8dm9pZD4ge1xuICAgIGNvbnN0IHsgYnVja2V0TmFtZSwgb2JqZWN0TmFtZSwgdGFncywgcHV0T3B0cyB9ID0gdGFnZ2luZ1BhcmFtc1xuICAgIGNvbnN0IG1ldGhvZCA9ICdQVVQnXG4gICAgbGV0IHF1ZXJ5ID0gJ3RhZ2dpbmcnXG5cbiAgICBpZiAocHV0T3B0cyAmJiBwdXRPcHRzPy52ZXJzaW9uSWQpIHtcbiAgICAgIHF1ZXJ5ID0gYCR7cXVlcnl9JnZlcnNpb25JZD0ke3B1dE9wdHMudmVyc2lvbklkfWBcbiAgICB9XG4gICAgY29uc3QgdGFnc0xpc3QgPSBbXVxuICAgIGZvciAoY29uc3QgW2tleSwgdmFsdWVdIG9mIE9iamVjdC5lbnRyaWVzKHRhZ3MpKSB7XG4gICAgICB0YWdzTGlzdC5wdXNoKHsgS2V5OiBrZXksIFZhbHVlOiB2YWx1ZSB9KVxuICAgIH1cbiAgICBjb25zdCB0YWdnaW5nQ29uZmlnID0ge1xuICAgICAgVGFnZ2luZzoge1xuICAgICAgICBUYWdTZXQ6IHtcbiAgICAgICAgICBUYWc6IHRhZ3NMaXN0LFxuICAgICAgICB9LFxuICAgICAgfSxcbiAgICB9XG4gICAgY29uc3QgaGVhZGVycyA9IHt9IGFzIFJlcXVlc3RIZWFkZXJzXG4gICAgY29uc3QgYnVpbGRlciA9IG5ldyB4bWwyanMuQnVpbGRlcih7IGhlYWRsZXNzOiB0cnVlLCByZW5kZXJPcHRzOiB7IHByZXR0eTogZmFsc2UgfSB9KVxuICAgIGNvbnN0IHBheWxvYWRCdWYgPSBCdWZmZXIuZnJvbShidWlsZGVyLmJ1aWxkT2JqZWN0KHRhZ2dpbmdDb25maWcpKVxuICAgIGNvbnN0IHJlcXVlc3RPcHRpb25zID0ge1xuICAgICAgbWV0aG9kLFxuICAgICAgYnVja2V0TmFtZSxcbiAgICAgIHF1ZXJ5LFxuICAgICAgaGVhZGVycyxcblxuICAgICAgLi4uKG9iamVjdE5hbWUgJiYgeyBvYmplY3ROYW1lOiBvYmplY3ROYW1lIH0pLFxuICAgIH1cblxuICAgIGhlYWRlcnNbJ0NvbnRlbnQtTUQ1J10gPSB0b01kNShwYXlsb2FkQnVmKVxuXG4gICAgYXdhaXQgdGhpcy5tYWtlUmVxdWVzdEFzeW5jT21pdChyZXF1ZXN0T3B0aW9ucywgcGF5bG9hZEJ1ZilcbiAgfVxuXG4gIHByaXZhdGUgYXN5bmMgcmVtb3ZlVGFnZ2luZyh7IGJ1Y2tldE5hbWUsIG9iamVjdE5hbWUsIHJlbW92ZU9wdHMgfTogUmVtb3ZlVGFnZ2luZ1BhcmFtcyk6IFByb21pc2U8dm9pZD4ge1xuICAgIGNvbnN0IG1ldGhvZCA9ICdERUxFVEUnXG4gICAgbGV0IHF1ZXJ5ID0gJ3RhZ2dpbmcnXG5cbiAgICBpZiAocmVtb3ZlT3B0cyAmJiBPYmplY3Qua2V5cyhyZW1vdmVPcHRzKS5sZW5ndGggJiYgcmVtb3ZlT3B0cy52ZXJzaW9uSWQpIHtcbiAgICAgIHF1ZXJ5ID0gYCR7cXVlcnl9JnZlcnNpb25JZD0ke3JlbW92ZU9wdHMudmVyc2lvbklkfWBcbiAgICB9XG4gICAgY29uc3QgcmVxdWVzdE9wdGlvbnMgPSB7IG1ldGhvZCwgYnVja2V0TmFtZSwgb2JqZWN0TmFtZSwgcXVlcnkgfVxuXG4gICAgaWYgKG9iamVjdE5hbWUpIHtcbiAgICAgIHJlcXVlc3RPcHRpb25zWydvYmplY3ROYW1lJ10gPSBvYmplY3ROYW1lXG4gICAgfVxuICAgIGF3YWl0IHRoaXMubWFrZVJlcXVlc3RBc3luYyhyZXF1ZXN0T3B0aW9ucywgJycsIFsyMDAsIDIwNF0pXG4gIH1cblxuICBhc3luYyBzZXRCdWNrZXRUYWdnaW5nKGJ1Y2tldE5hbWU6IHN0cmluZywgdGFnczogVGFncyk6IFByb21pc2U8dm9pZD4ge1xuICAgIGlmICghaXNWYWxpZEJ1Y2tldE5hbWUoYnVja2V0TmFtZSkpIHtcbiAgICAgIHRocm93IG5ldyBlcnJvcnMuSW52YWxpZEJ1Y2tldE5hbWVFcnJvcignSW52YWxpZCBidWNrZXQgbmFtZTogJyArIGJ1Y2tldE5hbWUpXG4gICAgfVxuICAgIGlmICghaXNQbGFpbk9iamVjdCh0YWdzKSkge1xuICAgICAgdGhyb3cgbmV3IGVycm9ycy5JbnZhbGlkQXJndW1lbnRFcnJvcigndGFncyBzaG91bGQgYmUgb2YgdHlwZSBcIm9iamVjdFwiJylcbiAgICB9XG4gICAgaWYgKE9iamVjdC5rZXlzKHRhZ3MpLmxlbmd0aCA+IDEwKSB7XG4gICAgICB0aHJvdyBuZXcgZXJyb3JzLkludmFsaWRBcmd1bWVudEVycm9yKCdtYXhpbXVtIHRhZ3MgYWxsb3dlZCBpcyAxMFwiJylcbiAgICB9XG5cbiAgICBhd2FpdCB0aGlzLnNldFRhZ2dpbmcoeyBidWNrZXROYW1lLCB0YWdzIH0pXG4gIH1cblxuICBhc3luYyByZW1vdmVCdWNrZXRUYWdnaW5nKGJ1Y2tldE5hbWU6IHN0cmluZykge1xuICAgIGlmICghaXNWYWxpZEJ1Y2tldE5hbWUoYnVja2V0TmFtZSkpIHtcbiAgICAgIHRocm93IG5ldyBlcnJvcnMuSW52YWxpZEJ1Y2tldE5hbWVFcnJvcignSW52YWxpZCBidWNrZXQgbmFtZTogJyArIGJ1Y2tldE5hbWUpXG4gICAgfVxuICAgIGF3YWl0IHRoaXMucmVtb3ZlVGFnZ2luZyh7IGJ1Y2tldE5hbWUgfSlcbiAgfVxuXG4gIGFzeW5jIHNldE9iamVjdFRhZ2dpbmcoYnVja2V0TmFtZTogc3RyaW5nLCBvYmplY3ROYW1lOiBzdHJpbmcsIHRhZ3M6IFRhZ3MsIHB1dE9wdHM/OiBUYWdnaW5nT3B0cykge1xuICAgIGlmICghaXNWYWxpZEJ1Y2tldE5hbWUoYnVja2V0TmFtZSkpIHtcbiAgICAgIHRocm93IG5ldyBlcnJvcnMuSW52YWxpZEJ1Y2tldE5hbWVFcnJvcignSW52YWxpZCBidWNrZXQgbmFtZTogJyArIGJ1Y2tldE5hbWUpXG4gICAgfVxuICAgIGlmICghaXNWYWxpZE9iamVjdE5hbWUob2JqZWN0TmFtZSkpIHtcbiAgICAgIHRocm93IG5ldyBlcnJvcnMuSW52YWxpZEJ1Y2tldE5hbWVFcnJvcignSW52YWxpZCBvYmplY3QgbmFtZTogJyArIG9iamVjdE5hbWUpXG4gICAgfVxuXG4gICAgaWYgKCFpc1BsYWluT2JqZWN0KHRhZ3MpKSB7XG4gICAgICB0aHJvdyBuZXcgZXJyb3JzLkludmFsaWRBcmd1bWVudEVycm9yKCd0YWdzIHNob3VsZCBiZSBvZiB0eXBlIFwib2JqZWN0XCInKVxuICAgIH1cbiAgICBpZiAoT2JqZWN0LmtleXModGFncykubGVuZ3RoID4gMTApIHtcbiAgICAgIHRocm93IG5ldyBlcnJvcnMuSW52YWxpZEFyZ3VtZW50RXJyb3IoJ01heGltdW0gdGFncyBhbGxvd2VkIGlzIDEwXCInKVxuICAgIH1cblxuICAgIGF3YWl0IHRoaXMuc2V0VGFnZ2luZyh7IGJ1Y2tldE5hbWUsIG9iamVjdE5hbWUsIHRhZ3MsIHB1dE9wdHMgfSlcbiAgfVxuXG4gIGFzeW5jIHJlbW92ZU9iamVjdFRhZ2dpbmcoYnVja2V0TmFtZTogc3RyaW5nLCBvYmplY3ROYW1lOiBzdHJpbmcsIHJlbW92ZU9wdHM6IFRhZ2dpbmdPcHRzKSB7XG4gICAgaWYgKCFpc1ZhbGlkQnVja2V0TmFtZShidWNrZXROYW1lKSkge1xuICAgICAgdGhyb3cgbmV3IGVycm9ycy5JbnZhbGlkQnVja2V0TmFtZUVycm9yKCdJbnZhbGlkIGJ1Y2tldCBuYW1lOiAnICsgYnVja2V0TmFtZSlcbiAgICB9XG4gICAgaWYgKCFpc1ZhbGlkT2JqZWN0TmFtZShvYmplY3ROYW1lKSkge1xuICAgICAgdGhyb3cgbmV3IGVycm9ycy5JbnZhbGlkQnVja2V0TmFtZUVycm9yKCdJbnZhbGlkIG9iamVjdCBuYW1lOiAnICsgb2JqZWN0TmFtZSlcbiAgICB9XG4gICAgaWYgKHJlbW92ZU9wdHMgJiYgT2JqZWN0LmtleXMocmVtb3ZlT3B0cykubGVuZ3RoICYmICFpc09iamVjdChyZW1vdmVPcHRzKSkge1xuICAgICAgdGhyb3cgbmV3IGVycm9ycy5JbnZhbGlkQXJndW1lbnRFcnJvcigncmVtb3ZlT3B0cyBzaG91bGQgYmUgb2YgdHlwZSBcIm9iamVjdFwiJylcbiAgICB9XG5cbiAgICBhd2FpdCB0aGlzLnJlbW92ZVRhZ2dpbmcoeyBidWNrZXROYW1lLCBvYmplY3ROYW1lLCByZW1vdmVPcHRzIH0pXG4gIH1cblxuICBhc3luYyBzZWxlY3RPYmplY3RDb250ZW50KFxuICAgIGJ1Y2tldE5hbWU6IHN0cmluZyxcbiAgICBvYmplY3ROYW1lOiBzdHJpbmcsXG4gICAgc2VsZWN0T3B0czogU2VsZWN0T3B0aW9ucyxcbiAgKTogUHJvbWlzZTxTZWxlY3RSZXN1bHRzIHwgdW5kZWZpbmVkPiB7XG4gICAgaWYgKCFpc1ZhbGlkQnVja2V0TmFtZShidWNrZXROYW1lKSkge1xuICAgICAgdGhyb3cgbmV3IGVycm9ycy5JbnZhbGlkQnVja2V0TmFtZUVycm9yKGBJbnZhbGlkIGJ1Y2tldCBuYW1lOiAke2J1Y2tldE5hbWV9YClcbiAgICB9XG4gICAgaWYgKCFpc1ZhbGlkT2JqZWN0TmFtZShvYmplY3ROYW1lKSkge1xuICAgICAgdGhyb3cgbmV3IGVycm9ycy5JbnZhbGlkT2JqZWN0TmFtZUVycm9yKGBJbnZhbGlkIG9iamVjdCBuYW1lOiAke29iamVjdE5hbWV9YClcbiAgICB9XG4gICAgaWYgKCFfLmlzRW1wdHkoc2VsZWN0T3B0cykpIHtcbiAgICAgIGlmICghaXNTdHJpbmcoc2VsZWN0T3B0cy5leHByZXNzaW9uKSkge1xuICAgICAgICB0aHJvdyBuZXcgVHlwZUVycm9yKCdzcWxFeHByZXNzaW9uIHNob3VsZCBiZSBvZiB0eXBlIFwic3RyaW5nXCInKVxuICAgICAgfVxuICAgICAgaWYgKCFfLmlzRW1wdHkoc2VsZWN0T3B0cy5pbnB1dFNlcmlhbGl6YXRpb24pKSB7XG4gICAgICAgIGlmICghaXNPYmplY3Qoc2VsZWN0T3B0cy5pbnB1dFNlcmlhbGl6YXRpb24pKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IFR5cGVFcnJvcignaW5wdXRTZXJpYWxpemF0aW9uIHNob3VsZCBiZSBvZiB0eXBlIFwib2JqZWN0XCInKVxuICAgICAgICB9XG4gICAgICB9IGVsc2Uge1xuICAgICAgICB0aHJvdyBuZXcgVHlwZUVycm9yKCdpbnB1dFNlcmlhbGl6YXRpb24gaXMgcmVxdWlyZWQnKVxuICAgICAgfVxuICAgICAgaWYgKCFfLmlzRW1wdHkoc2VsZWN0T3B0cy5vdXRwdXRTZXJpYWxpemF0aW9uKSkge1xuICAgICAgICBpZiAoIWlzT2JqZWN0KHNlbGVjdE9wdHMub3V0cHV0U2VyaWFsaXphdGlvbikpIHtcbiAgICAgICAgICB0aHJvdyBuZXcgVHlwZUVycm9yKCdvdXRwdXRTZXJpYWxpemF0aW9uIHNob3VsZCBiZSBvZiB0eXBlIFwib2JqZWN0XCInKVxuICAgICAgICB9XG4gICAgICB9IGVsc2Uge1xuICAgICAgICB0aHJvdyBuZXcgVHlwZUVycm9yKCdvdXRwdXRTZXJpYWxpemF0aW9uIGlzIHJlcXVpcmVkJylcbiAgICAgIH1cbiAgICB9IGVsc2Uge1xuICAgICAgdGhyb3cgbmV3IFR5cGVFcnJvcigndmFsaWQgc2VsZWN0IGNvbmZpZ3VyYXRpb24gaXMgcmVxdWlyZWQnKVxuICAgIH1cblxuICAgIGNvbnN0IG1ldGhvZCA9ICdQT1NUJ1xuICAgIGNvbnN0IHF1ZXJ5ID0gYHNlbGVjdCZzZWxlY3QtdHlwZT0yYFxuXG4gICAgY29uc3QgY29uZmlnOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPltdID0gW1xuICAgICAge1xuICAgICAgICBFeHByZXNzaW9uOiBzZWxlY3RPcHRzLmV4cHJlc3Npb24sXG4gICAgICB9LFxuICAgICAge1xuICAgICAgICBFeHByZXNzaW9uVHlwZTogc2VsZWN0T3B0cy5leHByZXNzaW9uVHlwZSB8fCAnU1FMJyxcbiAgICAgIH0sXG4gICAgICB7XG4gICAgICAgIElucHV0U2VyaWFsaXphdGlvbjogW3NlbGVjdE9wdHMuaW5wdXRTZXJpYWxpemF0aW9uXSxcbiAgICAgIH0sXG4gICAgICB7XG4gICAgICAgIE91dHB1dFNlcmlhbGl6YXRpb246IFtzZWxlY3RPcHRzLm91dHB1dFNlcmlhbGl6YXRpb25dLFxuICAgICAgfSxcbiAgICBdXG5cbiAgICAvLyBPcHRpb25hbFxuICAgIGlmIChzZWxlY3RPcHRzLnJlcXVlc3RQcm9ncmVzcykge1xuICAgICAgY29uZmlnLnB1c2goeyBSZXF1ZXN0UHJvZ3Jlc3M6IHNlbGVjdE9wdHM/LnJlcXVlc3RQcm9ncmVzcyB9KVxuICAgIH1cbiAgICAvLyBPcHRpb25hbFxuICAgIGlmIChzZWxlY3RPcHRzLnNjYW5SYW5nZSkge1xuICAgICAgY29uZmlnLnB1c2goeyBTY2FuUmFuZ2U6IHNlbGVjdE9wdHMuc2NhblJhbmdlIH0pXG4gICAgfVxuXG4gICAgY29uc3QgYnVpbGRlciA9IG5ldyB4bWwyanMuQnVpbGRlcih7XG4gICAgICByb290TmFtZTogJ1NlbGVjdE9iamVjdENvbnRlbnRSZXF1ZXN0JyxcbiAgICAgIHJlbmRlck9wdHM6IHsgcHJldHR5OiBmYWxzZSB9LFxuICAgICAgaGVhZGxlc3M6IHRydWUsXG4gICAgfSlcbiAgICBjb25zdCBwYXlsb2FkID0gYnVpbGRlci5idWlsZE9iamVjdChjb25maWcpXG5cbiAgICBjb25zdCByZXMgPSBhd2FpdCB0aGlzLm1ha2VSZXF1ZXN0QXN5bmMoeyBtZXRob2QsIGJ1Y2tldE5hbWUsIG9iamVjdE5hbWUsIHF1ZXJ5IH0sIHBheWxvYWQpXG4gICAgY29uc3QgYm9keSA9IGF3YWl0IHJlYWRBc0J1ZmZlcihyZXMpXG4gICAgcmV0dXJuIHBhcnNlU2VsZWN0T2JqZWN0Q29udGVudFJlc3BvbnNlKGJvZHkpXG4gIH1cblxuICBwcml2YXRlIGFzeW5jIGFwcGx5QnVja2V0TGlmZWN5Y2xlKGJ1Y2tldE5hbWU6IHN0cmluZywgcG9saWN5Q29uZmlnOiBMaWZlQ3ljbGVDb25maWdQYXJhbSk6IFByb21pc2U8dm9pZD4ge1xuICAgIGNvbnN0IG1ldGhvZCA9ICdQVVQnXG4gICAgY29uc3QgcXVlcnkgPSAnbGlmZWN5Y2xlJ1xuXG4gICAgY29uc3QgaGVhZGVyczogUmVxdWVzdEhlYWRlcnMgPSB7fVxuICAgIGNvbnN0IGJ1aWxkZXIgPSBuZXcgeG1sMmpzLkJ1aWxkZXIoe1xuICAgICAgcm9vdE5hbWU6ICdMaWZlY3ljbGVDb25maWd1cmF0aW9uJyxcbiAgICAgIGhlYWRsZXNzOiB0cnVlLFxuICAgICAgcmVuZGVyT3B0czogeyBwcmV0dHk6IGZhbHNlIH0sXG4gICAgfSlcbiAgICBjb25zdCBwYXlsb2FkID0gYnVpbGRlci5idWlsZE9iamVjdChwb2xpY3lDb25maWcpXG4gICAgaGVhZGVyc1snQ29udGVudC1NRDUnXSA9IHRvTWQ1KHBheWxvYWQpXG5cbiAgICBhd2FpdCB0aGlzLm1ha2VSZXF1ZXN0QXN5bmNPbWl0KHsgbWV0aG9kLCBidWNrZXROYW1lLCBxdWVyeSwgaGVhZGVycyB9LCBwYXlsb2FkKVxuICB9XG5cbiAgYXN5bmMgcmVtb3ZlQnVja2V0TGlmZWN5Y2xlKGJ1Y2tldE5hbWU6IHN0cmluZyk6IFByb21pc2U8dm9pZD4ge1xuICAgIGlmICghaXNWYWxpZEJ1Y2tldE5hbWUoYnVja2V0TmFtZSkpIHtcbiAgICAgIHRocm93IG5ldyBlcnJvcnMuSW52YWxpZEJ1Y2tldE5hbWVFcnJvcignSW52YWxpZCBidWNrZXQgbmFtZTogJyArIGJ1Y2tldE5hbWUpXG4gICAgfVxuICAgIGNvbnN0IG1ldGhvZCA9ICdERUxFVEUnXG4gICAgY29uc3QgcXVlcnkgPSAnbGlmZWN5Y2xlJ1xuICAgIGF3YWl0IHRoaXMubWFrZVJlcXVlc3RBc3luY09taXQoeyBtZXRob2QsIGJ1Y2tldE5hbWUsIHF1ZXJ5IH0sICcnLCBbMjA0XSlcbiAgfVxuXG4gIGFzeW5jIHNldEJ1Y2tldExpZmVjeWNsZShidWNrZXROYW1lOiBzdHJpbmcsIGxpZmVDeWNsZUNvbmZpZzogTGlmZUN5Y2xlQ29uZmlnUGFyYW0pOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBpZiAoIWlzVmFsaWRCdWNrZXROYW1lKGJ1Y2tldE5hbWUpKSB7XG4gICAgICB0aHJvdyBuZXcgZXJyb3JzLkludmFsaWRCdWNrZXROYW1lRXJyb3IoJ0ludmFsaWQgYnVja2V0IG5hbWU6ICcgKyBidWNrZXROYW1lKVxuICAgIH1cbiAgICBpZiAoXy5pc0VtcHR5KGxpZmVDeWNsZUNvbmZpZykpIHtcbiAgICAgIGF3YWl0IHRoaXMucmVtb3ZlQnVja2V0TGlmZWN5Y2xlKGJ1Y2tldE5hbWUpXG4gICAgfSBlbHNlIHtcbiAgICAgIGF3YWl0IHRoaXMuYXBwbHlCdWNrZXRMaWZlY3ljbGUoYnVja2V0TmFtZSwgbGlmZUN5Y2xlQ29uZmlnKVxuICAgIH1cbiAgfVxuXG4gIGFzeW5jIGdldEJ1Y2tldExpZmVjeWNsZShidWNrZXROYW1lOiBzdHJpbmcpOiBQcm9taXNlPExpZmVjeWNsZUNvbmZpZyB8IG51bGw+IHtcbiAgICBpZiAoIWlzVmFsaWRCdWNrZXROYW1lKGJ1Y2tldE5hbWUpKSB7XG4gICAgICB0aHJvdyBuZXcgZXJyb3JzLkludmFsaWRCdWNrZXROYW1lRXJyb3IoJ0ludmFsaWQgYnVja2V0IG5hbWU6ICcgKyBidWNrZXROYW1lKVxuICAgIH1cbiAgICBjb25zdCBtZXRob2QgPSAnR0VUJ1xuICAgIGNvbnN0IHF1ZXJ5ID0gJ2xpZmVjeWNsZSdcblxuICAgIGNvbnN0IHJlcyA9IGF3YWl0IHRoaXMubWFrZVJlcXVlc3RBc3luYyh7IG1ldGhvZCwgYnVja2V0TmFtZSwgcXVlcnkgfSlcbiAgICBjb25zdCBib2R5ID0gYXdhaXQgcmVhZEFzU3RyaW5nKHJlcylcbiAgICByZXR1cm4geG1sUGFyc2Vycy5wYXJzZUxpZmVjeWNsZUNvbmZpZyhib2R5KVxuICB9XG5cbiAgYXN5bmMgc2V0QnVja2V0RW5jcnlwdGlvbihidWNrZXROYW1lOiBzdHJpbmcsIGVuY3J5cHRpb25Db25maWc/OiBFbmNyeXB0aW9uQ29uZmlnKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgaWYgKCFpc1ZhbGlkQnVja2V0TmFtZShidWNrZXROYW1lKSkge1xuICAgICAgdGhyb3cgbmV3IGVycm9ycy5JbnZhbGlkQnVja2V0TmFtZUVycm9yKCdJbnZhbGlkIGJ1Y2tldCBuYW1lOiAnICsgYnVja2V0TmFtZSlcbiAgICB9XG4gICAgaWYgKCFfLmlzRW1wdHkoZW5jcnlwdGlvbkNvbmZpZykgJiYgZW5jcnlwdGlvbkNvbmZpZy5SdWxlLmxlbmd0aCA+IDEpIHtcbiAgICAgIHRocm93IG5ldyBlcnJvcnMuSW52YWxpZEFyZ3VtZW50RXJyb3IoJ0ludmFsaWQgUnVsZSBsZW5ndGguIE9ubHkgb25lIHJ1bGUgaXMgYWxsb3dlZC46ICcgKyBlbmNyeXB0aW9uQ29uZmlnLlJ1bGUpXG4gICAgfVxuXG4gICAgbGV0IGVuY3J5cHRpb25PYmogPSBlbmNyeXB0aW9uQ29uZmlnXG4gICAgaWYgKF8uaXNFbXB0eShlbmNyeXB0aW9uQ29uZmlnKSkge1xuICAgICAgZW5jcnlwdGlvbk9iaiA9IHtcbiAgICAgICAgLy8gRGVmYXVsdCBNaW5JTyBTZXJ2ZXIgU3VwcG9ydGVkIFJ1bGVcbiAgICAgICAgUnVsZTogW1xuICAgICAgICAgIHtcbiAgICAgICAgICAgIEFwcGx5U2VydmVyU2lkZUVuY3J5cHRpb25CeURlZmF1bHQ6IHtcbiAgICAgICAgICAgICAgU1NFQWxnb3JpdGhtOiAnQUVTMjU2JyxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgfSxcbiAgICAgICAgXSxcbiAgICAgIH1cbiAgICB9XG5cbiAgICBjb25zdCBtZXRob2QgPSAnUFVUJ1xuICAgIGNvbnN0IHF1ZXJ5ID0gJ2VuY3J5cHRpb24nXG4gICAgY29uc3QgYnVpbGRlciA9IG5ldyB4bWwyanMuQnVpbGRlcih7XG4gICAgICByb290TmFtZTogJ1NlcnZlclNpZGVFbmNyeXB0aW9uQ29uZmlndXJhdGlvbicsXG4gICAgICByZW5kZXJPcHRzOiB7IHByZXR0eTogZmFsc2UgfSxcbiAgICAgIGhlYWRsZXNzOiB0cnVlLFxuICAgIH0pXG4gICAgY29uc3QgcGF5bG9hZCA9IGJ1aWxkZXIuYnVpbGRPYmplY3QoZW5jcnlwdGlvbk9iailcblxuICAgIGNvbnN0IGhlYWRlcnM6IFJlcXVlc3RIZWFkZXJzID0ge31cbiAgICBoZWFkZXJzWydDb250ZW50LU1ENSddID0gdG9NZDUocGF5bG9hZClcblxuICAgIGF3YWl0IHRoaXMubWFrZVJlcXVlc3RBc3luY09taXQoeyBtZXRob2QsIGJ1Y2tldE5hbWUsIHF1ZXJ5LCBoZWFkZXJzIH0sIHBheWxvYWQpXG4gIH1cblxuICBhc3luYyBnZXRCdWNrZXRFbmNyeXB0aW9uKGJ1Y2tldE5hbWU6IHN0cmluZykge1xuICAgIGlmICghaXNWYWxpZEJ1Y2tldE5hbWUoYnVja2V0TmFtZSkpIHtcbiAgICAgIHRocm93IG5ldyBlcnJvcnMuSW52YWxpZEJ1Y2tldE5hbWVFcnJvcignSW52YWxpZCBidWNrZXQgbmFtZTogJyArIGJ1Y2tldE5hbWUpXG4gICAgfVxuICAgIGNvbnN0IG1ldGhvZCA9ICdHRVQnXG4gICAgY29uc3QgcXVlcnkgPSAnZW5jcnlwdGlvbidcblxuICAgIGNvbnN0IHJlcyA9IGF3YWl0IHRoaXMubWFrZVJlcXVlc3RBc3luYyh7IG1ldGhvZCwgYnVja2V0TmFtZSwgcXVlcnkgfSlcbiAgICBjb25zdCBib2R5ID0gYXdhaXQgcmVhZEFzU3RyaW5nKHJlcylcbiAgICByZXR1cm4geG1sUGFyc2Vycy5wYXJzZUJ1Y2tldEVuY3J5cHRpb25Db25maWcoYm9keSlcbiAgfVxuXG4gIGFzeW5jIHJlbW92ZUJ1Y2tldEVuY3J5cHRpb24oYnVja2V0TmFtZTogc3RyaW5nKSB7XG4gICAgaWYgKCFpc1ZhbGlkQnVja2V0TmFtZShidWNrZXROYW1lKSkge1xuICAgICAgdGhyb3cgbmV3IGVycm9ycy5JbnZhbGlkQnVja2V0TmFtZUVycm9yKCdJbnZhbGlkIGJ1Y2tldCBuYW1lOiAnICsgYnVja2V0TmFtZSlcbiAgICB9XG4gICAgY29uc3QgbWV0aG9kID0gJ0RFTEVURSdcbiAgICBjb25zdCBxdWVyeSA9ICdlbmNyeXB0aW9uJ1xuXG4gICAgYXdhaXQgdGhpcy5tYWtlUmVxdWVzdEFzeW5jT21pdCh7IG1ldGhvZCwgYnVja2V0TmFtZSwgcXVlcnkgfSwgJycsIFsyMDRdKVxuICB9XG5cbiAgYXN5bmMgZ2V0T2JqZWN0UmV0ZW50aW9uKFxuICAgIGJ1Y2tldE5hbWU6IHN0cmluZyxcbiAgICBvYmplY3ROYW1lOiBzdHJpbmcsXG4gICAgZ2V0T3B0cz86IEdldE9iamVjdFJldGVudGlvbk9wdHMsXG4gICk6IFByb21pc2U8T2JqZWN0UmV0ZW50aW9uSW5mbyB8IG51bGwgfCB1bmRlZmluZWQ+IHtcbiAgICBpZiAoIWlzVmFsaWRCdWNrZXROYW1lKGJ1Y2tldE5hbWUpKSB7XG4gICAgICB0aHJvdyBuZXcgZXJyb3JzLkludmFsaWRCdWNrZXROYW1lRXJyb3IoJ0ludmFsaWQgYnVja2V0IG5hbWU6ICcgKyBidWNrZXROYW1lKVxuICAgIH1cbiAgICBpZiAoIWlzVmFsaWRPYmplY3ROYW1lKG9iamVjdE5hbWUpKSB7XG4gICAgICB0aHJvdyBuZXcgZXJyb3JzLkludmFsaWRPYmplY3ROYW1lRXJyb3IoYEludmFsaWQgb2JqZWN0IG5hbWU6ICR7b2JqZWN0TmFtZX1gKVxuICAgIH1cbiAgICBpZiAoZ2V0T3B0cyAmJiAhaXNPYmplY3QoZ2V0T3B0cykpIHtcbiAgICAgIHRocm93IG5ldyBlcnJvcnMuSW52YWxpZEFyZ3VtZW50RXJyb3IoJ2dldE9wdHMgc2hvdWxkIGJlIG9mIHR5cGUgXCJvYmplY3RcIicpXG4gICAgfSBlbHNlIGlmIChnZXRPcHRzPy52ZXJzaW9uSWQgJiYgIWlzU3RyaW5nKGdldE9wdHMudmVyc2lvbklkKSkge1xuICAgICAgdGhyb3cgbmV3IGVycm9ycy5JbnZhbGlkQXJndW1lbnRFcnJvcigndmVyc2lvbklkIHNob3VsZCBiZSBvZiB0eXBlIFwic3RyaW5nXCInKVxuICAgIH1cblxuICAgIGNvbnN0IG1ldGhvZCA9ICdHRVQnXG4gICAgbGV0IHF1ZXJ5ID0gJ3JldGVudGlvbidcbiAgICBpZiAoZ2V0T3B0cz8udmVyc2lvbklkKSB7XG4gICAgICBxdWVyeSArPSBgJnZlcnNpb25JZD0ke2dldE9wdHMudmVyc2lvbklkfWBcbiAgICB9XG4gICAgY29uc3QgcmVzID0gYXdhaXQgdGhpcy5tYWtlUmVxdWVzdEFzeW5jKHsgbWV0aG9kLCBidWNrZXROYW1lLCBvYmplY3ROYW1lLCBxdWVyeSB9KVxuICAgIGNvbnN0IGJvZHkgPSBhd2FpdCByZWFkQXNTdHJpbmcocmVzKVxuICAgIHJldHVybiB4bWxQYXJzZXJzLnBhcnNlT2JqZWN0UmV0ZW50aW9uQ29uZmlnKGJvZHkpXG4gIH1cblxuICBhc3luYyByZW1vdmVPYmplY3RzKGJ1Y2tldE5hbWU6IHN0cmluZywgb2JqZWN0c0xpc3Q6IFJlbW92ZU9iamVjdHNQYXJhbSk6IFByb21pc2U8UmVtb3ZlT2JqZWN0c1Jlc3BvbnNlW10+IHtcbiAgICBpZiAoIWlzVmFsaWRCdWNrZXROYW1lKGJ1Y2tldE5hbWUpKSB7XG4gICAgICB0aHJvdyBuZXcgZXJyb3JzLkludmFsaWRCdWNrZXROYW1lRXJyb3IoJ0ludmFsaWQgYnVja2V0IG5hbWU6ICcgKyBidWNrZXROYW1lKVxuICAgIH1cbiAgICBpZiAoIUFycmF5LmlzQXJyYXkob2JqZWN0c0xpc3QpKSB7XG4gICAgICB0aHJvdyBuZXcgZXJyb3JzLkludmFsaWRBcmd1bWVudEVycm9yKCdvYmplY3RzTGlzdCBzaG91bGQgYmUgYSBsaXN0JylcbiAgICB9XG5cbiAgICBjb25zdCBydW5EZWxldGVPYmplY3RzID0gYXN5bmMgKGJhdGNoOiBSZW1vdmVPYmplY3RzUGFyYW0pOiBQcm9taXNlPFJlbW92ZU9iamVjdHNSZXNwb25zZVtdPiA9PiB7XG4gICAgICBjb25zdCBkZWxPYmplY3RzOiBSZW1vdmVPYmplY3RzUmVxdWVzdEVudHJ5W10gPSBiYXRjaC5tYXAoKHZhbHVlKSA9PiB7XG4gICAgICAgIHJldHVybiBpc09iamVjdCh2YWx1ZSkgPyB7IEtleTogdmFsdWUubmFtZSwgVmVyc2lvbklkOiB2YWx1ZS52ZXJzaW9uSWQgfSA6IHsgS2V5OiB2YWx1ZSB9XG4gICAgICB9KVxuXG4gICAgICBjb25zdCByZW1PYmplY3RzID0geyBEZWxldGU6IHsgUXVpZXQ6IHRydWUsIE9iamVjdDogZGVsT2JqZWN0cyB9IH1cbiAgICAgIGNvbnN0IHBheWxvYWQgPSBCdWZmZXIuZnJvbShuZXcgeG1sMmpzLkJ1aWxkZXIoeyBoZWFkbGVzczogdHJ1ZSB9KS5idWlsZE9iamVjdChyZW1PYmplY3RzKSlcbiAgICAgIGNvbnN0IGhlYWRlcnM6IFJlcXVlc3RIZWFkZXJzID0geyAnQ29udGVudC1NRDUnOiB0b01kNShwYXlsb2FkKSB9XG5cbiAgICAgIGNvbnN0IHJlcyA9IGF3YWl0IHRoaXMubWFrZVJlcXVlc3RBc3luYyh7IG1ldGhvZDogJ1BPU1QnLCBidWNrZXROYW1lLCBxdWVyeTogJ2RlbGV0ZScsIGhlYWRlcnMgfSwgcGF5bG9hZClcbiAgICAgIGNvbnN0IGJvZHkgPSBhd2FpdCByZWFkQXNTdHJpbmcocmVzKVxuICAgICAgcmV0dXJuIHhtbFBhcnNlcnMucmVtb3ZlT2JqZWN0c1BhcnNlcihib2R5KVxuICAgIH1cblxuICAgIGNvbnN0IG1heEVudHJpZXMgPSAxMDAwIC8vIG1heCBlbnRyaWVzIGFjY2VwdGVkIGluIHNlcnZlciBmb3IgRGVsZXRlTXVsdGlwbGVPYmplY3RzIEFQSS5cbiAgICAvLyBDbGllbnQgc2lkZSBiYXRjaGluZ1xuICAgIGNvbnN0IGJhdGNoZXMgPSBbXVxuICAgIGZvciAobGV0IGkgPSAwOyBpIDwgb2JqZWN0c0xpc3QubGVuZ3RoOyBpICs9IG1heEVudHJpZXMpIHtcbiAgICAgIGJhdGNoZXMucHVzaChvYmplY3RzTGlzdC5zbGljZShpLCBpICsgbWF4RW50cmllcykpXG4gICAgfVxuXG4gICAgY29uc3QgYmF0Y2hSZXN1bHRzID0gYXdhaXQgUHJvbWlzZS5hbGwoYmF0Y2hlcy5tYXAocnVuRGVsZXRlT2JqZWN0cykpXG4gICAgcmV0dXJuIGJhdGNoUmVzdWx0cy5mbGF0KClcbiAgfVxuXG4gIGFzeW5jIHJlbW92ZUluY29tcGxldGVVcGxvYWQoYnVja2V0TmFtZTogc3RyaW5nLCBvYmplY3ROYW1lOiBzdHJpbmcpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBpZiAoIWlzVmFsaWRCdWNrZXROYW1lKGJ1Y2tldE5hbWUpKSB7XG4gICAgICB0aHJvdyBuZXcgZXJyb3JzLklzVmFsaWRCdWNrZXROYW1lRXJyb3IoJ0ludmFsaWQgYnVja2V0IG5hbWU6ICcgKyBidWNrZXROYW1lKVxuICAgIH1cbiAgICBpZiAoIWlzVmFsaWRPYmplY3ROYW1lKG9iamVjdE5hbWUpKSB7XG4gICAgICB0aHJvdyBuZXcgZXJyb3JzLkludmFsaWRPYmplY3ROYW1lRXJyb3IoYEludmFsaWQgb2JqZWN0IG5hbWU6ICR7b2JqZWN0TmFtZX1gKVxuICAgIH1cbiAgICBjb25zdCByZW1vdmVVcGxvYWRJZCA9IGF3YWl0IHRoaXMuZmluZFVwbG9hZElkKGJ1Y2tldE5hbWUsIG9iamVjdE5hbWUpXG4gICAgY29uc3QgbWV0aG9kID0gJ0RFTEVURSdcbiAgICBjb25zdCBxdWVyeSA9IGB1cGxvYWRJZD0ke3JlbW92ZVVwbG9hZElkfWBcbiAgICBhd2FpdCB0aGlzLm1ha2VSZXF1ZXN0QXN5bmNPbWl0KHsgbWV0aG9kLCBidWNrZXROYW1lLCBvYmplY3ROYW1lLCBxdWVyeSB9LCAnJywgWzIwNF0pXG4gIH1cblxuICBwcml2YXRlIGFzeW5jIGNvcHlPYmplY3RWMShcbiAgICB0YXJnZXRCdWNrZXROYW1lOiBzdHJpbmcsXG4gICAgdGFyZ2V0T2JqZWN0TmFtZTogc3RyaW5nLFxuICAgIHNvdXJjZUJ1Y2tldE5hbWVBbmRPYmplY3ROYW1lOiBzdHJpbmcsXG4gICAgY29uZGl0aW9ucz86IG51bGwgfCBDb3B5Q29uZGl0aW9ucyxcbiAgKSB7XG4gICAgaWYgKHR5cGVvZiBjb25kaXRpb25zID09ICdmdW5jdGlvbicpIHtcbiAgICAgIGNvbmRpdGlvbnMgPSBudWxsXG4gICAgfVxuXG4gICAgaWYgKCFpc1ZhbGlkQnVja2V0TmFtZSh0YXJnZXRCdWNrZXROYW1lKSkge1xuICAgICAgdGhyb3cgbmV3IGVycm9ycy5JbnZhbGlkQnVja2V0TmFtZUVycm9yKCdJbnZhbGlkIGJ1Y2tldCBuYW1lOiAnICsgdGFyZ2V0QnVja2V0TmFtZSlcbiAgICB9XG4gICAgaWYgKCFpc1ZhbGlkT2JqZWN0TmFtZSh0YXJnZXRPYmplY3ROYW1lKSkge1xuICAgICAgdGhyb3cgbmV3IGVycm9ycy5JbnZhbGlkT2JqZWN0TmFtZUVycm9yKGBJbnZhbGlkIG9iamVjdCBuYW1lOiAke3RhcmdldE9iamVjdE5hbWV9YClcbiAgICB9XG4gICAgaWYgKCFpc1N0cmluZyhzb3VyY2VCdWNrZXROYW1lQW5kT2JqZWN0TmFtZSkpIHtcbiAgICAgIHRocm93IG5ldyBUeXBlRXJyb3IoJ3NvdXJjZUJ1Y2tldE5hbWVBbmRPYmplY3ROYW1lIHNob3VsZCBiZSBvZiB0eXBlIFwic3RyaW5nXCInKVxuICAgIH1cbiAgICBpZiAoc291cmNlQnVja2V0TmFtZUFuZE9iamVjdE5hbWUgPT09ICcnKSB7XG4gICAgICB0aHJvdyBuZXcgZXJyb3JzLkludmFsaWRQcmVmaXhFcnJvcihgRW1wdHkgc291cmNlIHByZWZpeGApXG4gICAgfVxuXG4gICAgaWYgKGNvbmRpdGlvbnMgIT0gbnVsbCAmJiAhKGNvbmRpdGlvbnMgaW5zdGFuY2VvZiBDb3B5Q29uZGl0aW9ucykpIHtcbiAgICAgIHRocm93IG5ldyBUeXBlRXJyb3IoJ2NvbmRpdGlvbnMgc2hvdWxkIGJlIG9mIHR5cGUgXCJDb3B5Q29uZGl0aW9uc1wiJylcbiAgICB9XG5cbiAgICBjb25zdCBoZWFkZXJzOiBSZXF1ZXN0SGVhZGVycyA9IHt9XG4gICAgaGVhZGVyc1sneC1hbXotY29weS1zb3VyY2UnXSA9IHVyaVJlc291cmNlRXNjYXBlKHNvdXJjZUJ1Y2tldE5hbWVBbmRPYmplY3ROYW1lKVxuXG4gICAgaWYgKGNvbmRpdGlvbnMpIHtcbiAgICAgIGlmIChjb25kaXRpb25zLm1vZGlmaWVkICE9PSAnJykge1xuICAgICAgICBoZWFkZXJzWyd4LWFtei1jb3B5LXNvdXJjZS1pZi1tb2RpZmllZC1zaW5jZSddID0gY29uZGl0aW9ucy5tb2RpZmllZFxuICAgICAgfVxuICAgICAgaWYgKGNvbmRpdGlvbnMudW5tb2RpZmllZCAhPT0gJycpIHtcbiAgICAgICAgaGVhZGVyc1sneC1hbXotY29weS1zb3VyY2UtaWYtdW5tb2RpZmllZC1zaW5jZSddID0gY29uZGl0aW9ucy51bm1vZGlmaWVkXG4gICAgICB9XG4gICAgICBpZiAoY29uZGl0aW9ucy5tYXRjaEVUYWcgIT09ICcnKSB7XG4gICAgICAgIGhlYWRlcnNbJ3gtYW16LWNvcHktc291cmNlLWlmLW1hdGNoJ10gPSBjb25kaXRpb25zLm1hdGNoRVRhZ1xuICAgICAgfVxuICAgICAgaWYgKGNvbmRpdGlvbnMubWF0Y2hFVGFnRXhjZXB0ICE9PSAnJykge1xuICAgICAgICBoZWFkZXJzWyd4LWFtei1jb3B5LXNvdXJjZS1pZi1ub25lLW1hdGNoJ10gPSBjb25kaXRpb25zLm1hdGNoRVRhZ0V4Y2VwdFxuICAgICAgfVxuICAgIH1cblxuICAgIGNvbnN0IG1ldGhvZCA9ICdQVVQnXG5cbiAgICBjb25zdCByZXMgPSBhd2FpdCB0aGlzLm1ha2VSZXF1ZXN0QXN5bmMoe1xuICAgICAgbWV0aG9kLFxuICAgICAgYnVja2V0TmFtZTogdGFyZ2V0QnVja2V0TmFtZSxcbiAgICAgIG9iamVjdE5hbWU6IHRhcmdldE9iamVjdE5hbWUsXG4gICAgICBoZWFkZXJzLFxuICAgIH0pXG4gICAgY29uc3QgYm9keSA9IGF3YWl0IHJlYWRBc1N0cmluZyhyZXMpXG4gICAgcmV0dXJuIHhtbFBhcnNlcnMucGFyc2VDb3B5T2JqZWN0KGJvZHkpXG4gIH1cblxuICBwcml2YXRlIGFzeW5jIGNvcHlPYmplY3RWMihcbiAgICBzb3VyY2VDb25maWc6IENvcHlTb3VyY2VPcHRpb25zLFxuICAgIGRlc3RDb25maWc6IENvcHlEZXN0aW5hdGlvbk9wdGlvbnMsXG4gICk6IFByb21pc2U8Q29weU9iamVjdFJlc3VsdFYyPiB7XG4gICAgaWYgKCEoc291cmNlQ29uZmlnIGluc3RhbmNlb2YgQ29weVNvdXJjZU9wdGlvbnMpKSB7XG4gICAgICB0aHJvdyBuZXcgZXJyb3JzLkludmFsaWRBcmd1bWVudEVycm9yKCdzb3VyY2VDb25maWcgc2hvdWxkIG9mIHR5cGUgQ29weVNvdXJjZU9wdGlvbnMgJylcbiAgICB9XG4gICAgaWYgKCEoZGVzdENvbmZpZyBpbnN0YW5jZW9mIENvcHlEZXN0aW5hdGlvbk9wdGlvbnMpKSB7XG4gICAgICB0aHJvdyBuZXcgZXJyb3JzLkludmFsaWRBcmd1bWVudEVycm9yKCdkZXN0Q29uZmlnIHNob3VsZCBvZiB0eXBlIENvcHlEZXN0aW5hdGlvbk9wdGlvbnMgJylcbiAgICB9XG4gICAgaWYgKCFkZXN0Q29uZmlnLnZhbGlkYXRlKCkpIHtcbiAgICAgIHJldHVybiBQcm9taXNlLnJlamVjdCgpXG4gICAgfVxuICAgIGlmICghZGVzdENvbmZpZy52YWxpZGF0ZSgpKSB7XG4gICAgICByZXR1cm4gUHJvbWlzZS5yZWplY3QoKVxuICAgIH1cblxuICAgIGNvbnN0IGhlYWRlcnMgPSBPYmplY3QuYXNzaWduKHt9LCBzb3VyY2VDb25maWcuZ2V0SGVhZGVycygpLCBkZXN0Q29uZmlnLmdldEhlYWRlcnMoKSlcblxuICAgIGNvbnN0IGJ1Y2tldE5hbWUgPSBkZXN0Q29uZmlnLkJ1Y2tldFxuICAgIGNvbnN0IG9iamVjdE5hbWUgPSBkZXN0Q29uZmlnLk9iamVjdFxuXG4gICAgY29uc3QgbWV0aG9kID0gJ1BVVCdcblxuICAgIGNvbnN0IHJlcyA9IGF3YWl0IHRoaXMubWFrZVJlcXVlc3RBc3luYyh7IG1ldGhvZCwgYnVja2V0TmFtZSwgb2JqZWN0TmFtZSwgaGVhZGVycyB9KVxuICAgIGNvbnN0IGJvZHkgPSBhd2FpdCByZWFkQXNTdHJpbmcocmVzKVxuICAgIGNvbnN0IGNvcHlSZXMgPSB4bWxQYXJzZXJzLnBhcnNlQ29weU9iamVjdChib2R5KVxuICAgIGNvbnN0IHJlc0hlYWRlcnM6IEluY29taW5nSHR0cEhlYWRlcnMgPSByZXMuaGVhZGVyc1xuXG4gICAgY29uc3Qgc2l6ZUhlYWRlclZhbHVlID0gcmVzSGVhZGVycyAmJiByZXNIZWFkZXJzWydjb250ZW50LWxlbmd0aCddXG4gICAgY29uc3Qgc2l6ZSA9IHR5cGVvZiBzaXplSGVhZGVyVmFsdWUgPT09ICdudW1iZXInID8gc2l6ZUhlYWRlclZhbHVlIDogdW5kZWZpbmVkXG5cbiAgICByZXR1cm4ge1xuICAgICAgQnVja2V0OiBkZXN0Q29uZmlnLkJ1Y2tldCxcbiAgICAgIEtleTogZGVzdENvbmZpZy5PYmplY3QsXG4gICAgICBMYXN0TW9kaWZpZWQ6IGNvcHlSZXMubGFzdE1vZGlmaWVkLFxuICAgICAgTWV0YURhdGE6IGV4dHJhY3RNZXRhZGF0YShyZXNIZWFkZXJzIGFzIFJlc3BvbnNlSGVhZGVyKSxcbiAgICAgIFZlcnNpb25JZDogZ2V0VmVyc2lvbklkKHJlc0hlYWRlcnMgYXMgUmVzcG9uc2VIZWFkZXIpLFxuICAgICAgU291cmNlVmVyc2lvbklkOiBnZXRTb3VyY2VWZXJzaW9uSWQocmVzSGVhZGVycyBhcyBSZXNwb25zZUhlYWRlciksXG4gICAgICBFdGFnOiBzYW5pdGl6ZUVUYWcocmVzSGVhZGVycy5ldGFnKSxcbiAgICAgIFNpemU6IHNpemUsXG4gICAgfVxuICB9XG5cbiAgYXN5bmMgY29weU9iamVjdChzb3VyY2U6IENvcHlTb3VyY2VPcHRpb25zLCBkZXN0OiBDb3B5RGVzdGluYXRpb25PcHRpb25zKTogUHJvbWlzZTxDb3B5T2JqZWN0UmVzdWx0PlxuICBhc3luYyBjb3B5T2JqZWN0KFxuICAgIHRhcmdldEJ1Y2tldE5hbWU6IHN0cmluZyxcbiAgICB0YXJnZXRPYmplY3ROYW1lOiBzdHJpbmcsXG4gICAgc291cmNlQnVja2V0TmFtZUFuZE9iamVjdE5hbWU6IHN0cmluZyxcbiAgICBjb25kaXRpb25zPzogQ29weUNvbmRpdGlvbnMsXG4gICk6IFByb21pc2U8Q29weU9iamVjdFJlc3VsdD5cbiAgYXN5bmMgY29weU9iamVjdCguLi5hbGxBcmdzOiBDb3B5T2JqZWN0UGFyYW1zKTogUHJvbWlzZTxDb3B5T2JqZWN0UmVzdWx0PiB7XG4gICAgaWYgKHR5cGVvZiBhbGxBcmdzWzBdID09PSAnc3RyaW5nJykge1xuICAgICAgY29uc3QgW3RhcmdldEJ1Y2tldE5hbWUsIHRhcmdldE9iamVjdE5hbWUsIHNvdXJjZUJ1Y2tldE5hbWVBbmRPYmplY3ROYW1lLCBjb25kaXRpb25zXSA9IGFsbEFyZ3MgYXMgW1xuICAgICAgICBzdHJpbmcsXG4gICAgICAgIHN0cmluZyxcbiAgICAgICAgc3RyaW5nLFxuICAgICAgICBDb3B5Q29uZGl0aW9ucz8sXG4gICAgICBdXG4gICAgICByZXR1cm4gYXdhaXQgdGhpcy5jb3B5T2JqZWN0VjEodGFyZ2V0QnVja2V0TmFtZSwgdGFyZ2V0T2JqZWN0TmFtZSwgc291cmNlQnVja2V0TmFtZUFuZE9iamVjdE5hbWUsIGNvbmRpdGlvbnMpXG4gICAgfVxuICAgIGNvbnN0IFtzb3VyY2UsIGRlc3RdID0gYWxsQXJncyBhcyBbQ29weVNvdXJjZU9wdGlvbnMsIENvcHlEZXN0aW5hdGlvbk9wdGlvbnNdXG4gICAgcmV0dXJuIGF3YWl0IHRoaXMuY29weU9iamVjdFYyKHNvdXJjZSwgZGVzdClcbiAgfVxuXG4gIGFzeW5jIHVwbG9hZFBhcnQoXG4gICAgcGFydENvbmZpZzoge1xuICAgICAgYnVja2V0TmFtZTogc3RyaW5nXG4gICAgICBvYmplY3ROYW1lOiBzdHJpbmdcbiAgICAgIHVwbG9hZElEOiBzdHJpbmdcbiAgICAgIHBhcnROdW1iZXI6IG51bWJlclxuICAgICAgaGVhZGVyczogUmVxdWVzdEhlYWRlcnNcbiAgICB9LFxuICAgIHBheWxvYWQ/OiBCaW5hcnksXG4gICkge1xuICAgIGNvbnN0IHsgYnVja2V0TmFtZSwgb2JqZWN0TmFtZSwgdXBsb2FkSUQsIHBhcnROdW1iZXIsIGhlYWRlcnMgfSA9IHBhcnRDb25maWdcblxuICAgIGNvbnN0IG1ldGhvZCA9ICdQVVQnXG4gICAgY29uc3QgcXVlcnkgPSBgdXBsb2FkSWQ9JHt1cGxvYWRJRH0mcGFydE51bWJlcj0ke3BhcnROdW1iZXJ9YFxuICAgIGNvbnN0IHJlcXVlc3RPcHRpb25zID0geyBtZXRob2QsIGJ1Y2tldE5hbWUsIG9iamVjdE5hbWU6IG9iamVjdE5hbWUsIHF1ZXJ5LCBoZWFkZXJzIH1cbiAgICBjb25zdCByZXMgPSBhd2FpdCB0aGlzLm1ha2VSZXF1ZXN0QXN5bmMocmVxdWVzdE9wdGlvbnMsIHBheWxvYWQpXG4gICAgY29uc3QgYm9keSA9IGF3YWl0IHJlYWRBc1N0cmluZyhyZXMpXG4gICAgY29uc3QgcGFydFJlcyA9IHVwbG9hZFBhcnRQYXJzZXIoYm9keSlcbiAgICByZXR1cm4ge1xuICAgICAgZXRhZzogc2FuaXRpemVFVGFnKHBhcnRSZXMuRVRhZyksXG4gICAgICBrZXk6IG9iamVjdE5hbWUsXG4gICAgICBwYXJ0OiBwYXJ0TnVtYmVyLFxuICAgIH1cbiAgfVxuXG4gIGFzeW5jIGNvbXBvc2VPYmplY3QoXG4gICAgZGVzdE9iakNvbmZpZzogQ29weURlc3RpbmF0aW9uT3B0aW9ucyxcbiAgICBzb3VyY2VPYmpMaXN0OiBDb3B5U291cmNlT3B0aW9uc1tdLFxuICApOiBQcm9taXNlPGJvb2xlYW4gfCB7IGV0YWc6IHN0cmluZzsgdmVyc2lvbklkOiBzdHJpbmcgfCBudWxsIH0gfCBQcm9taXNlPHZvaWQ+IHwgQ29weU9iamVjdFJlc3VsdD4ge1xuICAgIGNvbnN0IHNvdXJjZUZpbGVzTGVuZ3RoID0gc291cmNlT2JqTGlzdC5sZW5ndGhcblxuICAgIGlmICghQXJyYXkuaXNBcnJheShzb3VyY2VPYmpMaXN0KSkge1xuICAgICAgdGhyb3cgbmV3IGVycm9ycy5JbnZhbGlkQXJndW1lbnRFcnJvcignc291cmNlQ29uZmlnIHNob3VsZCBhbiBhcnJheSBvZiBDb3B5U291cmNlT3B0aW9ucyAnKVxuICAgIH1cbiAgICBpZiAoIShkZXN0T2JqQ29uZmlnIGluc3RhbmNlb2YgQ29weURlc3RpbmF0aW9uT3B0aW9ucykpIHtcbiAgICAgIHRocm93IG5ldyBlcnJvcnMuSW52YWxpZEFyZ3VtZW50RXJyb3IoJ2Rlc3RDb25maWcgc2hvdWxkIG9mIHR5cGUgQ29weURlc3RpbmF0aW9uT3B0aW9ucyAnKVxuICAgIH1cblxuICAgIGlmIChzb3VyY2VGaWxlc0xlbmd0aCA8IDEgfHwgc291cmNlRmlsZXNMZW5ndGggPiBQQVJUX0NPTlNUUkFJTlRTLk1BWF9QQVJUU19DT1VOVCkge1xuICAgICAgdGhyb3cgbmV3IGVycm9ycy5JbnZhbGlkQXJndW1lbnRFcnJvcihcbiAgICAgICAgYFwiVGhlcmUgbXVzdCBiZSBhcyBsZWFzdCBvbmUgYW5kIHVwIHRvICR7UEFSVF9DT05TVFJBSU5UUy5NQVhfUEFSVFNfQ09VTlR9IHNvdXJjZSBvYmplY3RzLmAsXG4gICAgICApXG4gICAgfVxuXG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPCBzb3VyY2VGaWxlc0xlbmd0aDsgaSsrKSB7XG4gICAgICBjb25zdCBzT2JqID0gc291cmNlT2JqTGlzdFtpXSBhcyBDb3B5U291cmNlT3B0aW9uc1xuICAgICAgaWYgKCFzT2JqLnZhbGlkYXRlKCkpIHtcbiAgICAgICAgcmV0dXJuIGZhbHNlXG4gICAgICB9XG4gICAgfVxuXG4gICAgaWYgKCEoZGVzdE9iakNvbmZpZyBhcyBDb3B5RGVzdGluYXRpb25PcHRpb25zKS52YWxpZGF0ZSgpKSB7XG4gICAgICByZXR1cm4gZmFsc2VcbiAgICB9XG5cbiAgICBjb25zdCBnZXRTdGF0T3B0aW9ucyA9IChzcmNDb25maWc6IENvcHlTb3VyY2VPcHRpb25zKSA9PiB7XG4gICAgICBsZXQgc3RhdE9wdHMgPSB7fVxuICAgICAgaWYgKCFfLmlzRW1wdHkoc3JjQ29uZmlnLlZlcnNpb25JRCkpIHtcbiAgICAgICAgc3RhdE9wdHMgPSB7XG4gICAgICAgICAgdmVyc2lvbklkOiBzcmNDb25maWcuVmVyc2lvbklELFxuICAgICAgICB9XG4gICAgICB9XG4gICAgICByZXR1cm4gc3RhdE9wdHNcbiAgICB9XG4gICAgY29uc3Qgc3JjT2JqZWN0U2l6ZXM6IG51bWJlcltdID0gW11cbiAgICBsZXQgdG90YWxTaXplID0gMFxuICAgIGxldCB0b3RhbFBhcnRzID0gMFxuXG4gICAgY29uc3Qgc291cmNlT2JqU3RhdHMgPSBzb3VyY2VPYmpMaXN0Lm1hcCgoc3JjSXRlbSkgPT5cbiAgICAgIHRoaXMuc3RhdE9iamVjdChzcmNJdGVtLkJ1Y2tldCwgc3JjSXRlbS5PYmplY3QsIGdldFN0YXRPcHRpb25zKHNyY0l0ZW0pKSxcbiAgICApXG5cbiAgICBjb25zdCBzcmNPYmplY3RJbmZvcyA9IGF3YWl0IFByb21pc2UuYWxsKHNvdXJjZU9ialN0YXRzKVxuXG4gICAgY29uc3QgdmFsaWRhdGVkU3RhdHMgPSBzcmNPYmplY3RJbmZvcy5tYXAoKHJlc0l0ZW1TdGF0LCBpbmRleCkgPT4ge1xuICAgICAgY29uc3Qgc3JjQ29uZmlnOiBDb3B5U291cmNlT3B0aW9ucyB8IHVuZGVmaW5lZCA9IHNvdXJjZU9iakxpc3RbaW5kZXhdXG5cbiAgICAgIGxldCBzcmNDb3B5U2l6ZSA9IHJlc0l0ZW1TdGF0LnNpemVcbiAgICAgIC8vIENoZWNrIGlmIGEgc2VnbWVudCBpcyBzcGVjaWZpZWQsIGFuZCBpZiBzbywgaXMgdGhlXG4gICAgICAvLyBzZWdtZW50IHdpdGhpbiBvYmplY3QgYm91bmRzP1xuICAgICAgaWYgKHNyY0NvbmZpZyAmJiBzcmNDb25maWcuTWF0Y2hSYW5nZSkge1xuICAgICAgICAvLyBTaW5jZSByYW5nZSBpcyBzcGVjaWZpZWQsXG4gICAgICAgIC8vICAgIDAgPD0gc3JjLnNyY1N0YXJ0IDw9IHNyYy5zcmNFbmRcbiAgICAgICAgLy8gc28gb25seSBpbnZhbGlkIGNhc2UgdG8gY2hlY2sgaXM6XG4gICAgICAgIGNvbnN0IHNyY1N0YXJ0ID0gc3JjQ29uZmlnLlN0YXJ0XG4gICAgICAgIGNvbnN0IHNyY0VuZCA9IHNyY0NvbmZpZy5FbmRcbiAgICAgICAgaWYgKHNyY0VuZCA+PSBzcmNDb3B5U2l6ZSB8fCBzcmNTdGFydCA8IDApIHtcbiAgICAgICAgICB0aHJvdyBuZXcgZXJyb3JzLkludmFsaWRBcmd1bWVudEVycm9yKFxuICAgICAgICAgICAgYENvcHlTcmNPcHRpb25zICR7aW5kZXh9IGhhcyBpbnZhbGlkIHNlZ21lbnQtdG8tY29weSBbJHtzcmNTdGFydH0sICR7c3JjRW5kfV0gKHNpemUgaXMgJHtzcmNDb3B5U2l6ZX0pYCxcbiAgICAgICAgICApXG4gICAgICAgIH1cbiAgICAgICAgc3JjQ29weVNpemUgPSBzcmNFbmQgLSBzcmNTdGFydCArIDFcbiAgICAgIH1cblxuICAgICAgLy8gT25seSB0aGUgbGFzdCBzb3VyY2UgbWF5IGJlIGxlc3MgdGhhbiBgYWJzTWluUGFydFNpemVgXG4gICAgICBpZiAoc3JjQ29weVNpemUgPCBQQVJUX0NPTlNUUkFJTlRTLkFCU19NSU5fUEFSVF9TSVpFICYmIGluZGV4IDwgc291cmNlRmlsZXNMZW5ndGggLSAxKSB7XG4gICAgICAgIHRocm93IG5ldyBlcnJvcnMuSW52YWxpZEFyZ3VtZW50RXJyb3IoXG4gICAgICAgICAgYENvcHlTcmNPcHRpb25zICR7aW5kZXh9IGlzIHRvbyBzbWFsbCAoJHtzcmNDb3B5U2l6ZX0pIGFuZCBpdCBpcyBub3QgdGhlIGxhc3QgcGFydC5gLFxuICAgICAgICApXG4gICAgICB9XG5cbiAgICAgIC8vIElzIGRhdGEgdG8gY29weSB0b28gbGFyZ2U/XG4gICAgICB0b3RhbFNpemUgKz0gc3JjQ29weVNpemVcbiAgICAgIGlmICh0b3RhbFNpemUgPiBQQVJUX0NPTlNUUkFJTlRTLk1BWF9NVUxUSVBBUlRfUFVUX09CSkVDVF9TSVpFKSB7XG4gICAgICAgIHRocm93IG5ldyBlcnJvcnMuSW52YWxpZEFyZ3VtZW50RXJyb3IoYENhbm5vdCBjb21wb3NlIGFuIG9iamVjdCBvZiBzaXplICR7dG90YWxTaXplfSAoPiA1VGlCKWApXG4gICAgICB9XG5cbiAgICAgIC8vIHJlY29yZCBzb3VyY2Ugc2l6ZVxuICAgICAgc3JjT2JqZWN0U2l6ZXNbaW5kZXhdID0gc3JjQ29weVNpemVcblxuICAgICAgLy8gY2FsY3VsYXRlIHBhcnRzIG5lZWRlZCBmb3IgY3VycmVudCBzb3VyY2VcbiAgICAgIHRvdGFsUGFydHMgKz0gcGFydHNSZXF1aXJlZChzcmNDb3B5U2l6ZSlcbiAgICAgIC8vIERvIHdlIG5lZWQgbW9yZSBwYXJ0cyB0aGFuIHdlIGFyZSBhbGxvd2VkP1xuICAgICAgaWYgKHRvdGFsUGFydHMgPiBQQVJUX0NPTlNUUkFJTlRTLk1BWF9QQVJUU19DT1VOVCkge1xuICAgICAgICB0aHJvdyBuZXcgZXJyb3JzLkludmFsaWRBcmd1bWVudEVycm9yKFxuICAgICAgICAgIGBZb3VyIHByb3Bvc2VkIGNvbXBvc2Ugb2JqZWN0IHJlcXVpcmVzIG1vcmUgdGhhbiAke1BBUlRfQ09OU1RSQUlOVFMuTUFYX1BBUlRTX0NPVU5UfSBwYXJ0c2AsXG4gICAgICAgIClcbiAgICAgIH1cblxuICAgICAgcmV0dXJuIHJlc0l0ZW1TdGF0XG4gICAgfSlcblxuICAgIGlmICgodG90YWxQYXJ0cyA9PT0gMSAmJiB0b3RhbFNpemUgPD0gUEFSVF9DT05TVFJBSU5UUy5NQVhfUEFSVF9TSVpFKSB8fCB0b3RhbFNpemUgPT09IDApIHtcbiAgICAgIHJldHVybiBhd2FpdCB0aGlzLmNvcHlPYmplY3Qoc291cmNlT2JqTGlzdFswXSBhcyBDb3B5U291cmNlT3B0aW9ucywgZGVzdE9iakNvbmZpZykgLy8gdXNlIGNvcHlPYmplY3RWMlxuICAgIH1cblxuICAgIC8vIHByZXNlcnZlIGV0YWcgdG8gYXZvaWQgbW9kaWZpY2F0aW9uIG9mIG9iamVjdCB3aGlsZSBjb3B5aW5nLlxuICAgIGZvciAobGV0IGkgPSAwOyBpIDwgc291cmNlRmlsZXNMZW5ndGg7IGkrKykge1xuICAgICAgOyhzb3VyY2VPYmpMaXN0W2ldIGFzIENvcHlTb3VyY2VPcHRpb25zKS5NYXRjaEVUYWcgPSAodmFsaWRhdGVkU3RhdHNbaV0gYXMgQnVja2V0SXRlbVN0YXQpLmV0YWdcbiAgICB9XG5cbiAgICBjb25zdCBzcGxpdFBhcnRTaXplTGlzdCA9IHZhbGlkYXRlZFN0YXRzLm1hcCgocmVzSXRlbVN0YXQsIGlkeCkgPT4ge1xuICAgICAgcmV0dXJuIGNhbGN1bGF0ZUV2ZW5TcGxpdHMoc3JjT2JqZWN0U2l6ZXNbaWR4XSBhcyBudW1iZXIsIHNvdXJjZU9iakxpc3RbaWR4XSBhcyBDb3B5U291cmNlT3B0aW9ucylcbiAgICB9KVxuXG4gICAgY29uc3QgZ2V0VXBsb2FkUGFydENvbmZpZ0xpc3QgPSAodXBsb2FkSWQ6IHN0cmluZykgPT4ge1xuICAgICAgY29uc3QgdXBsb2FkUGFydENvbmZpZ0xpc3Q6IFVwbG9hZFBhcnRDb25maWdbXSA9IFtdXG5cbiAgICAgIHNwbGl0UGFydFNpemVMaXN0LmZvckVhY2goKHNwbGl0U2l6ZSwgc3BsaXRJbmRleDogbnVtYmVyKSA9PiB7XG4gICAgICAgIGlmIChzcGxpdFNpemUpIHtcbiAgICAgICAgICBjb25zdCB7IHN0YXJ0SW5kZXg6IHN0YXJ0SWR4LCBlbmRJbmRleDogZW5kSWR4LCBvYmpJbmZvOiBvYmpDb25maWcgfSA9IHNwbGl0U2l6ZVxuXG4gICAgICAgICAgY29uc3QgcGFydEluZGV4ID0gc3BsaXRJbmRleCArIDEgLy8gcGFydCBpbmRleCBzdGFydHMgZnJvbSAxLlxuICAgICAgICAgIGNvbnN0IHRvdGFsVXBsb2FkcyA9IEFycmF5LmZyb20oc3RhcnRJZHgpXG5cbiAgICAgICAgICBjb25zdCBoZWFkZXJzID0gKHNvdXJjZU9iakxpc3Rbc3BsaXRJbmRleF0gYXMgQ29weVNvdXJjZU9wdGlvbnMpLmdldEhlYWRlcnMoKVxuXG4gICAgICAgICAgdG90YWxVcGxvYWRzLmZvckVhY2goKHNwbGl0U3RhcnQsIHVwbGRDdHJJZHgpID0+IHtcbiAgICAgICAgICAgIGNvbnN0IHNwbGl0RW5kID0gZW5kSWR4W3VwbGRDdHJJZHhdXG5cbiAgICAgICAgICAgIGNvbnN0IHNvdXJjZU9iaiA9IGAke29iakNvbmZpZy5CdWNrZXR9LyR7b2JqQ29uZmlnLk9iamVjdH1gXG4gICAgICAgICAgICBoZWFkZXJzWyd4LWFtei1jb3B5LXNvdXJjZSddID0gYCR7c291cmNlT2JqfWBcbiAgICAgICAgICAgIGhlYWRlcnNbJ3gtYW16LWNvcHktc291cmNlLXJhbmdlJ10gPSBgYnl0ZXM9JHtzcGxpdFN0YXJ0fS0ke3NwbGl0RW5kfWBcblxuICAgICAgICAgICAgY29uc3QgdXBsb2FkUGFydENvbmZpZyA9IHtcbiAgICAgICAgICAgICAgYnVja2V0TmFtZTogZGVzdE9iakNvbmZpZy5CdWNrZXQsXG4gICAgICAgICAgICAgIG9iamVjdE5hbWU6IGRlc3RPYmpDb25maWcuT2JqZWN0LFxuICAgICAgICAgICAgICB1cGxvYWRJRDogdXBsb2FkSWQsXG4gICAgICAgICAgICAgIHBhcnROdW1iZXI6IHBhcnRJbmRleCxcbiAgICAgICAgICAgICAgaGVhZGVyczogaGVhZGVycyxcbiAgICAgICAgICAgICAgc291cmNlT2JqOiBzb3VyY2VPYmosXG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHVwbG9hZFBhcnRDb25maWdMaXN0LnB1c2godXBsb2FkUGFydENvbmZpZylcbiAgICAgICAgICB9KVxuICAgICAgICB9XG4gICAgICB9KVxuXG4gICAgICByZXR1cm4gdXBsb2FkUGFydENvbmZpZ0xpc3RcbiAgICB9XG5cbiAgICBjb25zdCB1cGxvYWRBbGxQYXJ0cyA9IGFzeW5jICh1cGxvYWRMaXN0OiBVcGxvYWRQYXJ0Q29uZmlnW10pID0+IHtcbiAgICAgIGNvbnN0IHBhcnRVcGxvYWRzID0gdXBsb2FkTGlzdC5tYXAoYXN5bmMgKGl0ZW0pID0+IHtcbiAgICAgICAgcmV0dXJuIHRoaXMudXBsb2FkUGFydChpdGVtKVxuICAgICAgfSlcbiAgICAgIC8vIFByb2Nlc3MgcmVzdWx0cyBoZXJlIGlmIG5lZWRlZFxuICAgICAgcmV0dXJuIGF3YWl0IFByb21pc2UuYWxsKHBhcnRVcGxvYWRzKVxuICAgIH1cblxuICAgIGNvbnN0IHBlcmZvcm1VcGxvYWRQYXJ0cyA9IGFzeW5jICh1cGxvYWRJZDogc3RyaW5nKSA9PiB7XG4gICAgICBjb25zdCB1cGxvYWRMaXN0ID0gZ2V0VXBsb2FkUGFydENvbmZpZ0xpc3QodXBsb2FkSWQpXG4gICAgICBjb25zdCBwYXJ0c1JlcyA9IGF3YWl0IHVwbG9hZEFsbFBhcnRzKHVwbG9hZExpc3QpXG4gICAgICByZXR1cm4gcGFydHNSZXMubWFwKChwYXJ0Q29weSkgPT4gKHsgZXRhZzogcGFydENvcHkuZXRhZywgcGFydDogcGFydENvcHkucGFydCB9KSlcbiAgICB9XG5cbiAgICBjb25zdCBuZXdVcGxvYWRIZWFkZXJzID0gZGVzdE9iakNvbmZpZy5nZXRIZWFkZXJzKClcblxuICAgIGNvbnN0IHVwbG9hZElkID0gYXdhaXQgdGhpcy5pbml0aWF0ZU5ld011bHRpcGFydFVwbG9hZChkZXN0T2JqQ29uZmlnLkJ1Y2tldCwgZGVzdE9iakNvbmZpZy5PYmplY3QsIG5ld1VwbG9hZEhlYWRlcnMpXG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHBhcnRzRG9uZSA9IGF3YWl0IHBlcmZvcm1VcGxvYWRQYXJ0cyh1cGxvYWRJZClcbiAgICAgIHJldHVybiBhd2FpdCB0aGlzLmNvbXBsZXRlTXVsdGlwYXJ0VXBsb2FkKGRlc3RPYmpDb25maWcuQnVja2V0LCBkZXN0T2JqQ29uZmlnLk9iamVjdCwgdXBsb2FkSWQsIHBhcnRzRG9uZSlcbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgIHJldHVybiBhd2FpdCB0aGlzLmFib3J0TXVsdGlwYXJ0VXBsb2FkKGRlc3RPYmpDb25maWcuQnVja2V0LCBkZXN0T2JqQ29uZmlnLk9iamVjdCwgdXBsb2FkSWQpXG4gICAgfVxuICB9XG5cbiAgYXN5bmMgcHJlc2lnbmVkVXJsKFxuICAgIG1ldGhvZDogc3RyaW5nLFxuICAgIGJ1Y2tldE5hbWU6IHN0cmluZyxcbiAgICBvYmplY3ROYW1lOiBzdHJpbmcsXG4gICAgZXhwaXJlcz86IG51bWJlciB8IFByZVNpZ25SZXF1ZXN0UGFyYW1zIHwgdW5kZWZpbmVkLFxuICAgIHJlcVBhcmFtcz86IFByZVNpZ25SZXF1ZXN0UGFyYW1zIHwgRGF0ZSxcbiAgICByZXF1ZXN0RGF0ZT86IERhdGUsXG4gICk6IFByb21pc2U8c3RyaW5nPiB7XG4gICAgaWYgKHRoaXMuYW5vbnltb3VzKSB7XG4gICAgICB0aHJvdyBuZXcgZXJyb3JzLkFub255bW91c1JlcXVlc3RFcnJvcihgUHJlc2lnbmVkICR7bWV0aG9kfSB1cmwgY2Fubm90IGJlIGdlbmVyYXRlZCBmb3IgYW5vbnltb3VzIHJlcXVlc3RzYClcbiAgICB9XG5cbiAgICBpZiAoIWV4cGlyZXMpIHtcbiAgICAgIGV4cGlyZXMgPSBQUkVTSUdOX0VYUElSWV9EQVlTX01BWFxuICAgIH1cbiAgICBpZiAoIXJlcVBhcmFtcykge1xuICAgICAgcmVxUGFyYW1zID0ge31cbiAgICB9XG4gICAgaWYgKCFyZXF1ZXN0RGF0ZSkge1xuICAgICAgcmVxdWVzdERhdGUgPSBuZXcgRGF0ZSgpXG4gICAgfVxuXG4gICAgLy8gVHlwZSBhc3NlcnRpb25zXG4gICAgaWYgKGV4cGlyZXMgJiYgdHlwZW9mIGV4cGlyZXMgIT09ICdudW1iZXInKSB7XG4gICAgICB0aHJvdyBuZXcgVHlwZUVycm9yKCdleHBpcmVzIHNob3VsZCBiZSBvZiB0eXBlIFwibnVtYmVyXCInKVxuICAgIH1cbiAgICBpZiAocmVxUGFyYW1zICYmIHR5cGVvZiByZXFQYXJhbXMgIT09ICdvYmplY3QnKSB7XG4gICAgICB0aHJvdyBuZXcgVHlwZUVycm9yKCdyZXFQYXJhbXMgc2hvdWxkIGJlIG9mIHR5cGUgXCJvYmplY3RcIicpXG4gICAgfVxuICAgIGlmICgocmVxdWVzdERhdGUgJiYgIShyZXF1ZXN0RGF0ZSBpbnN0YW5jZW9mIERhdGUpKSB8fCAocmVxdWVzdERhdGUgJiYgaXNOYU4ocmVxdWVzdERhdGU/LmdldFRpbWUoKSkpKSB7XG4gICAgICB0aHJvdyBuZXcgVHlwZUVycm9yKCdyZXF1ZXN0RGF0ZSBzaG91bGQgYmUgb2YgdHlwZSBcIkRhdGVcIiBhbmQgdmFsaWQnKVxuICAgIH1cblxuICAgIGNvbnN0IHF1ZXJ5ID0gcmVxUGFyYW1zID8gcXMuc3RyaW5naWZ5KHJlcVBhcmFtcykgOiB1bmRlZmluZWRcblxuICAgIHRyeSB7XG4gICAgICBjb25zdCByZWdpb24gPSBhd2FpdCB0aGlzLmdldEJ1Y2tldFJlZ2lvbkFzeW5jKGJ1Y2tldE5hbWUpXG4gICAgICBhd2FpdCB0aGlzLmNoZWNrQW5kUmVmcmVzaENyZWRzKClcbiAgICAgIGNvbnN0IHJlcU9wdGlvbnMgPSB0aGlzLmdldFJlcXVlc3RPcHRpb25zKHsgbWV0aG9kLCByZWdpb24sIGJ1Y2tldE5hbWUsIG9iamVjdE5hbWUsIHF1ZXJ5IH0pXG5cbiAgICAgIHJldHVybiBwcmVzaWduU2lnbmF0dXJlVjQoXG4gICAgICAgIHJlcU9wdGlvbnMsXG4gICAgICAgIHRoaXMuYWNjZXNzS2V5LFxuICAgICAgICB0aGlzLnNlY3JldEtleSxcbiAgICAgICAgdGhpcy5zZXNzaW9uVG9rZW4sXG4gICAgICAgIHJlZ2lvbixcbiAgICAgICAgcmVxdWVzdERhdGUsXG4gICAgICAgIGV4cGlyZXMsXG4gICAgICApXG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICBpZiAoZXJyIGluc3RhbmNlb2YgZXJyb3JzLkludmFsaWRCdWNrZXROYW1lRXJyb3IpIHtcbiAgICAgICAgdGhyb3cgbmV3IGVycm9ycy5JbnZhbGlkQXJndW1lbnRFcnJvcihgVW5hYmxlIHRvIGdldCBidWNrZXQgcmVnaW9uIGZvciAke2J1Y2tldE5hbWV9LmApXG4gICAgICB9XG5cbiAgICAgIHRocm93IGVyclxuICAgIH1cbiAgfVxuXG4gIGFzeW5jIHByZXNpZ25lZEdldE9iamVjdChcbiAgICBidWNrZXROYW1lOiBzdHJpbmcsXG4gICAgb2JqZWN0TmFtZTogc3RyaW5nLFxuICAgIGV4cGlyZXM/OiBudW1iZXIsXG4gICAgcmVzcEhlYWRlcnM/OiBQcmVTaWduUmVxdWVzdFBhcmFtcyB8IERhdGUsXG4gICAgcmVxdWVzdERhdGU/OiBEYXRlLFxuICApOiBQcm9taXNlPHN0cmluZz4ge1xuICAgIGlmICghaXNWYWxpZEJ1Y2tldE5hbWUoYnVja2V0TmFtZSkpIHtcbiAgICAgIHRocm93IG5ldyBlcnJvcnMuSW52YWxpZEJ1Y2tldE5hbWVFcnJvcignSW52YWxpZCBidWNrZXQgbmFtZTogJyArIGJ1Y2tldE5hbWUpXG4gICAgfVxuICAgIGlmICghaXNWYWxpZE9iamVjdE5hbWUob2JqZWN0TmFtZSkpIHtcbiAgICAgIHRocm93IG5ldyBlcnJvcnMuSW52YWxpZE9iamVjdE5hbWVFcnJvcihgSW52YWxpZCBvYmplY3QgbmFtZTogJHtvYmplY3ROYW1lfWApXG4gICAgfVxuXG4gICAgY29uc3QgdmFsaWRSZXNwSGVhZGVycyA9IFtcbiAgICAgICdyZXNwb25zZS1jb250ZW50LXR5cGUnLFxuICAgICAgJ3Jlc3BvbnNlLWNvbnRlbnQtbGFuZ3VhZ2UnLFxuICAgICAgJ3Jlc3BvbnNlLWV4cGlyZXMnLFxuICAgICAgJ3Jlc3BvbnNlLWNhY2hlLWNvbnRyb2wnLFxuICAgICAgJ3Jlc3BvbnNlLWNvbnRlbnQtZGlzcG9zaXRpb24nLFxuICAgICAgJ3Jlc3BvbnNlLWNvbnRlbnQtZW5jb2RpbmcnLFxuICAgIF1cbiAgICB2YWxpZFJlc3BIZWFkZXJzLmZvckVhY2goKGhlYWRlcikgPT4ge1xuICAgICAgLy8gQHRzLWlnbm9yZVxuICAgICAgaWYgKHJlc3BIZWFkZXJzICE9PSB1bmRlZmluZWQgJiYgcmVzcEhlYWRlcnNbaGVhZGVyXSAhPT0gdW5kZWZpbmVkICYmICFpc1N0cmluZyhyZXNwSGVhZGVyc1toZWFkZXJdKSkge1xuICAgICAgICB0aHJvdyBuZXcgVHlwZUVycm9yKGByZXNwb25zZSBoZWFkZXIgJHtoZWFkZXJ9IHNob3VsZCBiZSBvZiB0eXBlIFwic3RyaW5nXCJgKVxuICAgICAgfVxuICAgIH0pXG4gICAgcmV0dXJuIHRoaXMucHJlc2lnbmVkVXJsKCdHRVQnLCBidWNrZXROYW1lLCBvYmplY3ROYW1lLCBleHBpcmVzLCByZXNwSGVhZGVycywgcmVxdWVzdERhdGUpXG4gIH1cblxuICBhc3luYyBwcmVzaWduZWRQdXRPYmplY3QoYnVja2V0TmFtZTogc3RyaW5nLCBvYmplY3ROYW1lOiBzdHJpbmcsIGV4cGlyZXM/OiBudW1iZXIpOiBQcm9taXNlPHN0cmluZz4ge1xuICAgIGlmICghaXNWYWxpZEJ1Y2tldE5hbWUoYnVja2V0TmFtZSkpIHtcbiAgICAgIHRocm93IG5ldyBlcnJvcnMuSW52YWxpZEJ1Y2tldE5hbWVFcnJvcihgSW52YWxpZCBidWNrZXQgbmFtZTogJHtidWNrZXROYW1lfWApXG4gICAgfVxuICAgIGlmICghaXNWYWxpZE9iamVjdE5hbWUob2JqZWN0TmFtZSkpIHtcbiAgICAgIHRocm93IG5ldyBlcnJvcnMuSW52YWxpZE9iamVjdE5hbWVFcnJvcihgSW52YWxpZCBvYmplY3QgbmFtZTogJHtvYmplY3ROYW1lfWApXG4gICAgfVxuXG4gICAgcmV0dXJuIHRoaXMucHJlc2lnbmVkVXJsKCdQVVQnLCBidWNrZXROYW1lLCBvYmplY3ROYW1lLCBleHBpcmVzKVxuICB9XG5cbiAgbmV3UG9zdFBvbGljeSgpOiBQb3N0UG9saWN5IHtcbiAgICByZXR1cm4gbmV3IFBvc3RQb2xpY3koKVxuICB9XG5cbiAgYXN5bmMgcHJlc2lnbmVkUG9zdFBvbGljeShwb3N0UG9saWN5OiBQb3N0UG9saWN5KTogUHJvbWlzZTxQb3N0UG9saWN5UmVzdWx0PiB7XG4gICAgaWYgKHRoaXMuYW5vbnltb3VzKSB7XG4gICAgICB0aHJvdyBuZXcgZXJyb3JzLkFub255bW91c1JlcXVlc3RFcnJvcignUHJlc2lnbmVkIFBPU1QgcG9saWN5IGNhbm5vdCBiZSBnZW5lcmF0ZWQgZm9yIGFub255bW91cyByZXF1ZXN0cycpXG4gICAgfVxuICAgIGlmICghaXNPYmplY3QocG9zdFBvbGljeSkpIHtcbiAgICAgIHRocm93IG5ldyBUeXBlRXJyb3IoJ3Bvc3RQb2xpY3kgc2hvdWxkIGJlIG9mIHR5cGUgXCJvYmplY3RcIicpXG4gICAgfVxuICAgIGNvbnN0IGJ1Y2tldE5hbWUgPSBwb3N0UG9saWN5LmZvcm1EYXRhLmJ1Y2tldCBhcyBzdHJpbmdcbiAgICB0cnkge1xuICAgICAgY29uc3QgcmVnaW9uID0gYXdhaXQgdGhpcy5nZXRCdWNrZXRSZWdpb25Bc3luYyhidWNrZXROYW1lKVxuXG4gICAgICBjb25zdCBkYXRlID0gbmV3IERhdGUoKVxuICAgICAgY29uc3QgZGF0ZVN0ciA9IG1ha2VEYXRlTG9uZyhkYXRlKVxuICAgICAgYXdhaXQgdGhpcy5jaGVja0FuZFJlZnJlc2hDcmVkcygpXG5cbiAgICAgIGlmICghcG9zdFBvbGljeS5wb2xpY3kuZXhwaXJhdGlvbikge1xuICAgICAgICAvLyAnZXhwaXJhdGlvbicgaXMgbWFuZGF0b3J5IGZpZWxkIGZvciBTMy5cbiAgICAgICAgLy8gU2V0IGRlZmF1bHQgZXhwaXJhdGlvbiBkYXRlIG9mIDcgZGF5cy5cbiAgICAgICAgY29uc3QgZXhwaXJlcyA9IG5ldyBEYXRlKClcbiAgICAgICAgZXhwaXJlcy5zZXRTZWNvbmRzKFBSRVNJR05fRVhQSVJZX0RBWVNfTUFYKVxuICAgICAgICBwb3N0UG9saWN5LnNldEV4cGlyZXMoZXhwaXJlcylcbiAgICAgIH1cblxuICAgICAgcG9zdFBvbGljeS5wb2xpY3kuY29uZGl0aW9ucy5wdXNoKFsnZXEnLCAnJHgtYW16LWRhdGUnLCBkYXRlU3RyXSlcbiAgICAgIHBvc3RQb2xpY3kuZm9ybURhdGFbJ3gtYW16LWRhdGUnXSA9IGRhdGVTdHJcblxuICAgICAgcG9zdFBvbGljeS5wb2xpY3kuY29uZGl0aW9ucy5wdXNoKFsnZXEnLCAnJHgtYW16LWFsZ29yaXRobScsICdBV1M0LUhNQUMtU0hBMjU2J10pXG4gICAgICBwb3N0UG9saWN5LmZvcm1EYXRhWyd4LWFtei1hbGdvcml0aG0nXSA9ICdBV1M0LUhNQUMtU0hBMjU2J1xuXG4gICAgICBwb3N0UG9saWN5LnBvbGljeS5jb25kaXRpb25zLnB1c2goWydlcScsICckeC1hbXotY3JlZGVudGlhbCcsIHRoaXMuYWNjZXNzS2V5ICsgJy8nICsgZ2V0U2NvcGUocmVnaW9uLCBkYXRlKV0pXG4gICAgICBwb3N0UG9saWN5LmZvcm1EYXRhWyd4LWFtei1jcmVkZW50aWFsJ10gPSB0aGlzLmFjY2Vzc0tleSArICcvJyArIGdldFNjb3BlKHJlZ2lvbiwgZGF0ZSlcblxuICAgICAgaWYgKHRoaXMuc2Vzc2lvblRva2VuKSB7XG4gICAgICAgIHBvc3RQb2xpY3kucG9saWN5LmNvbmRpdGlvbnMucHVzaChbJ2VxJywgJyR4LWFtei1zZWN1cml0eS10b2tlbicsIHRoaXMuc2Vzc2lvblRva2VuXSlcbiAgICAgICAgcG9zdFBvbGljeS5mb3JtRGF0YVsneC1hbXotc2VjdXJpdHktdG9rZW4nXSA9IHRoaXMuc2Vzc2lvblRva2VuXG4gICAgICB9XG5cbiAgICAgIGNvbnN0IHBvbGljeUJhc2U2NCA9IEJ1ZmZlci5mcm9tKEpTT04uc3RyaW5naWZ5KHBvc3RQb2xpY3kucG9saWN5KSkudG9TdHJpbmcoJ2Jhc2U2NCcpXG5cbiAgICAgIHBvc3RQb2xpY3kuZm9ybURhdGEucG9saWN5ID0gcG9saWN5QmFzZTY0XG5cbiAgICAgIHBvc3RQb2xpY3kuZm9ybURhdGFbJ3gtYW16LXNpZ25hdHVyZSddID0gcG9zdFByZXNpZ25TaWduYXR1cmVWNChyZWdpb24sIGRhdGUsIHRoaXMuc2VjcmV0S2V5LCBwb2xpY3lCYXNlNjQpXG4gICAgICBjb25zdCBvcHRzID0ge1xuICAgICAgICByZWdpb246IHJlZ2lvbixcbiAgICAgICAgYnVja2V0TmFtZTogYnVja2V0TmFtZSxcbiAgICAgICAgbWV0aG9kOiAnUE9TVCcsXG4gICAgICB9XG4gICAgICBjb25zdCByZXFPcHRpb25zID0gdGhpcy5nZXRSZXF1ZXN0T3B0aW9ucyhvcHRzKVxuICAgICAgY29uc3QgcG9ydFN0ciA9IHRoaXMucG9ydCA9PSA4MCB8fCB0aGlzLnBvcnQgPT09IDQ0MyA/ICcnIDogYDoke3RoaXMucG9ydC50b1N0cmluZygpfWBcbiAgICAgIGNvbnN0IHVybFN0ciA9IGAke3JlcU9wdGlvbnMucHJvdG9jb2x9Ly8ke3JlcU9wdGlvbnMuaG9zdH0ke3BvcnRTdHJ9JHtyZXFPcHRpb25zLnBhdGh9YFxuICAgICAgcmV0dXJuIHsgcG9zdFVSTDogdXJsU3RyLCBmb3JtRGF0YTogcG9zdFBvbGljeS5mb3JtRGF0YSB9XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICBpZiAoZXJyIGluc3RhbmNlb2YgZXJyb3JzLkludmFsaWRCdWNrZXROYW1lRXJyb3IpIHtcbiAgICAgICAgdGhyb3cgbmV3IGVycm9ycy5JbnZhbGlkQXJndW1lbnRFcnJvcihgVW5hYmxlIHRvIGdldCBidWNrZXQgcmVnaW9uIGZvciAke2J1Y2tldE5hbWV9LmApXG4gICAgICB9XG5cbiAgICAgIHRocm93IGVyclxuICAgIH1cbiAgfVxuICAvLyBsaXN0IGEgYmF0Y2ggb2Ygb2JqZWN0c1xuICBhc3luYyBsaXN0T2JqZWN0c1F1ZXJ5KGJ1Y2tldE5hbWU6IHN0cmluZywgcHJlZml4Pzogc3RyaW5nLCBtYXJrZXI/OiBzdHJpbmcsIGxpc3RRdWVyeU9wdHM/OiBMaXN0T2JqZWN0UXVlcnlPcHRzKSB7XG4gICAgaWYgKCFpc1ZhbGlkQnVja2V0TmFtZShidWNrZXROYW1lKSkge1xuICAgICAgdGhyb3cgbmV3IGVycm9ycy5JbnZhbGlkQnVja2V0TmFtZUVycm9yKCdJbnZhbGlkIGJ1Y2tldCBuYW1lOiAnICsgYnVja2V0TmFtZSlcbiAgICB9XG4gICAgaWYgKCFpc1N0cmluZyhwcmVmaXgpKSB7XG4gICAgICB0aHJvdyBuZXcgVHlwZUVycm9yKCdwcmVmaXggc2hvdWxkIGJlIG9mIHR5cGUgXCJzdHJpbmdcIicpXG4gICAgfVxuICAgIGlmIChtYXJrZXIgJiYgIWlzU3RyaW5nKG1hcmtlcikpIHtcbiAgICAgIHRocm93IG5ldyBUeXBlRXJyb3IoJ21hcmtlciBzaG91bGQgYmUgb2YgdHlwZSBcInN0cmluZ1wiJylcbiAgICB9XG5cbiAgICBpZiAobGlzdFF1ZXJ5T3B0cyAmJiAhaXNPYmplY3QobGlzdFF1ZXJ5T3B0cykpIHtcbiAgICAgIHRocm93IG5ldyBUeXBlRXJyb3IoJ2xpc3RRdWVyeU9wdHMgc2hvdWxkIGJlIG9mIHR5cGUgXCJvYmplY3RcIicpXG4gICAgfVxuICAgIGxldCB7IERlbGltaXRlciwgTWF4S2V5cywgSW5jbHVkZVZlcnNpb24sIHZlcnNpb25JZE1hcmtlciwga2V5TWFya2VyIH0gPSBsaXN0UXVlcnlPcHRzIGFzIExpc3RPYmplY3RRdWVyeU9wdHNcblxuICAgIGlmICghaXNTdHJpbmcoRGVsaW1pdGVyKSkge1xuICAgICAgdGhyb3cgbmV3IFR5cGVFcnJvcignRGVsaW1pdGVyIHNob3VsZCBiZSBvZiB0eXBlIFwic3RyaW5nXCInKVxuICAgIH1cbiAgICBpZiAoIWlzTnVtYmVyKE1heEtleXMpKSB7XG4gICAgICB0aHJvdyBuZXcgVHlwZUVycm9yKCdNYXhLZXlzIHNob3VsZCBiZSBvZiB0eXBlIFwibnVtYmVyXCInKVxuICAgIH1cblxuICAgIGNvbnN0IHF1ZXJpZXMgPSBbXVxuICAgIC8vIGVzY2FwZSBldmVyeSB2YWx1ZSBpbiBxdWVyeSBzdHJpbmcsIGV4Y2VwdCBtYXhLZXlzXG4gICAgcXVlcmllcy5wdXNoKGBwcmVmaXg9JHt1cmlFc2NhcGUocHJlZml4KX1gKVxuICAgIHF1ZXJpZXMucHVzaChgZGVsaW1pdGVyPSR7dXJpRXNjYXBlKERlbGltaXRlcil9YClcbiAgICBxdWVyaWVzLnB1c2goYGVuY29kaW5nLXR5cGU9dXJsYClcblxuICAgIGlmIChJbmNsdWRlVmVyc2lvbikge1xuICAgICAgcXVlcmllcy5wdXNoKGB2ZXJzaW9uc2ApXG4gICAgfVxuXG4gICAgaWYgKEluY2x1ZGVWZXJzaW9uKSB7XG4gICAgICAvLyB2MSB2ZXJzaW9uIGxpc3RpbmcuLlxuICAgICAgaWYgKGtleU1hcmtlcikge1xuICAgICAgICBxdWVyaWVzLnB1c2goYGtleS1tYXJrZXI9JHtrZXlNYXJrZXJ9YClcbiAgICAgIH1cbiAgICAgIGlmICh2ZXJzaW9uSWRNYXJrZXIpIHtcbiAgICAgICAgcXVlcmllcy5wdXNoKGB2ZXJzaW9uLWlkLW1hcmtlcj0ke3ZlcnNpb25JZE1hcmtlcn1gKVxuICAgICAgfVxuICAgIH0gZWxzZSBpZiAobWFya2VyKSB7XG4gICAgICBtYXJrZXIgPSB1cmlFc2NhcGUobWFya2VyKVxuICAgICAgcXVlcmllcy5wdXNoKGBtYXJrZXI9JHttYXJrZXJ9YClcbiAgICB9XG5cbiAgICAvLyBubyBuZWVkIHRvIGVzY2FwZSBtYXhLZXlzXG4gICAgaWYgKE1heEtleXMpIHtcbiAgICAgIGlmIChNYXhLZXlzID49IDEwMDApIHtcbiAgICAgICAgTWF4S2V5cyA9IDEwMDBcbiAgICAgIH1cbiAgICAgIHF1ZXJpZXMucHVzaChgbWF4LWtleXM9JHtNYXhLZXlzfWApXG4gICAgfVxuICAgIHF1ZXJpZXMuc29ydCgpXG4gICAgbGV0IHF1ZXJ5ID0gJydcbiAgICBpZiAocXVlcmllcy5sZW5ndGggPiAwKSB7XG4gICAgICBxdWVyeSA9IGAke3F1ZXJpZXMuam9pbignJicpfWBcbiAgICB9XG5cbiAgICBjb25zdCBtZXRob2QgPSAnR0VUJ1xuICAgIGNvbnN0IHJlcyA9IGF3YWl0IHRoaXMubWFrZVJlcXVlc3RBc3luYyh7IG1ldGhvZCwgYnVja2V0TmFtZSwgcXVlcnkgfSlcbiAgICBjb25zdCBib2R5ID0gYXdhaXQgcmVhZEFzU3RyaW5nKHJlcylcbiAgICBjb25zdCBsaXN0UXJ5TGlzdCA9IHBhcnNlTGlzdE9iamVjdHMoYm9keSlcbiAgICByZXR1cm4gbGlzdFFyeUxpc3RcbiAgfVxuXG4gIGxpc3RPYmplY3RzKFxuICAgIGJ1Y2tldE5hbWU6IHN0cmluZyxcbiAgICBwcmVmaXg/OiBzdHJpbmcsXG4gICAgcmVjdXJzaXZlPzogYm9vbGVhbixcbiAgICBsaXN0T3B0cz86IExpc3RPYmplY3RRdWVyeU9wdHMgfCB1bmRlZmluZWQsXG4gICk6IEJ1Y2tldFN0cmVhbTxPYmplY3RJbmZvPiB7XG4gICAgaWYgKHByZWZpeCA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICBwcmVmaXggPSAnJ1xuICAgIH1cbiAgICBpZiAocmVjdXJzaXZlID09PSB1bmRlZmluZWQpIHtcbiAgICAgIHJlY3Vyc2l2ZSA9IGZhbHNlXG4gICAgfVxuICAgIGlmICghaXNWYWxpZEJ1Y2tldE5hbWUoYnVja2V0TmFtZSkpIHtcbiAgICAgIHRocm93IG5ldyBlcnJvcnMuSW52YWxpZEJ1Y2tldE5hbWVFcnJvcignSW52YWxpZCBidWNrZXQgbmFtZTogJyArIGJ1Y2tldE5hbWUpXG4gICAgfVxuICAgIGlmICghaXNWYWxpZFByZWZpeChwcmVmaXgpKSB7XG4gICAgICB0aHJvdyBuZXcgZXJyb3JzLkludmFsaWRQcmVmaXhFcnJvcihgSW52YWxpZCBwcmVmaXggOiAke3ByZWZpeH1gKVxuICAgIH1cbiAgICBpZiAoIWlzU3RyaW5nKHByZWZpeCkpIHtcbiAgICAgIHRocm93IG5ldyBUeXBlRXJyb3IoJ3ByZWZpeCBzaG91bGQgYmUgb2YgdHlwZSBcInN0cmluZ1wiJylcbiAgICB9XG4gICAgaWYgKCFpc0Jvb2xlYW4ocmVjdXJzaXZlKSkge1xuICAgICAgdGhyb3cgbmV3IFR5cGVFcnJvcigncmVjdXJzaXZlIHNob3VsZCBiZSBvZiB0eXBlIFwiYm9vbGVhblwiJylcbiAgICB9XG4gICAgaWYgKGxpc3RPcHRzICYmICFpc09iamVjdChsaXN0T3B0cykpIHtcbiAgICAgIHRocm93IG5ldyBUeXBlRXJyb3IoJ2xpc3RPcHRzIHNob3VsZCBiZSBvZiB0eXBlIFwib2JqZWN0XCInKVxuICAgIH1cbiAgICBsZXQgbWFya2VyOiBzdHJpbmcgfCB1bmRlZmluZWQgPSAnJ1xuICAgIGxldCBrZXlNYXJrZXI6IHN0cmluZyB8IHVuZGVmaW5lZCA9ICcnXG4gICAgbGV0IHZlcnNpb25JZE1hcmtlcjogc3RyaW5nIHwgdW5kZWZpbmVkID0gJydcbiAgICBsZXQgb2JqZWN0czogT2JqZWN0SW5mb1tdID0gW11cbiAgICBsZXQgZW5kZWQgPSBmYWxzZVxuICAgIGNvbnN0IHJlYWRTdHJlYW06IHN0cmVhbS5SZWFkYWJsZSA9IG5ldyBzdHJlYW0uUmVhZGFibGUoeyBvYmplY3RNb2RlOiB0cnVlIH0pXG4gICAgcmVhZFN0cmVhbS5fcmVhZCA9IGFzeW5jICgpID0+IHtcbiAgICAgIC8vIHB1c2ggb25lIG9iamVjdCBwZXIgX3JlYWQoKVxuICAgICAgaWYgKG9iamVjdHMubGVuZ3RoKSB7XG4gICAgICAgIHJlYWRTdHJlYW0ucHVzaChvYmplY3RzLnNoaWZ0KCkpXG4gICAgICAgIHJldHVyblxuICAgICAgfVxuICAgICAgaWYgKGVuZGVkKSB7XG4gICAgICAgIHJldHVybiByZWFkU3RyZWFtLnB1c2gobnVsbClcbiAgICAgIH1cblxuICAgICAgdHJ5IHtcbiAgICAgICAgY29uc3QgbGlzdFF1ZXJ5T3B0cyA9IHtcbiAgICAgICAgICBEZWxpbWl0ZXI6IHJlY3Vyc2l2ZSA/ICcnIDogJy8nLCAvLyBpZiByZWN1cnNpdmUgaXMgZmFsc2Ugc2V0IGRlbGltaXRlciB0byAnLydcbiAgICAgICAgICBNYXhLZXlzOiAxMDAwLFxuICAgICAgICAgIEluY2x1ZGVWZXJzaW9uOiBsaXN0T3B0cz8uSW5jbHVkZVZlcnNpb24sXG4gICAgICAgICAgLy8gdmVyc2lvbiBsaXN0aW5nIHNwZWNpZmljIG9wdGlvbnNcbiAgICAgICAgICBrZXlNYXJrZXI6IGtleU1hcmtlcixcbiAgICAgICAgICB2ZXJzaW9uSWRNYXJrZXI6IHZlcnNpb25JZE1hcmtlcixcbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnN0IHJlc3VsdDogTGlzdE9iamVjdFF1ZXJ5UmVzID0gYXdhaXQgdGhpcy5saXN0T2JqZWN0c1F1ZXJ5KGJ1Y2tldE5hbWUsIHByZWZpeCwgbWFya2VyLCBsaXN0UXVlcnlPcHRzKVxuICAgICAgICBpZiAocmVzdWx0LmlzVHJ1bmNhdGVkKSB7XG4gICAgICAgICAgbWFya2VyID0gcmVzdWx0Lm5leHRNYXJrZXIgfHwgdW5kZWZpbmVkXG4gICAgICAgICAgaWYgKHJlc3VsdC5rZXlNYXJrZXIpIHtcbiAgICAgICAgICAgIGtleU1hcmtlciA9IHJlc3VsdC5rZXlNYXJrZXJcbiAgICAgICAgICB9XG4gICAgICAgICAgaWYgKHJlc3VsdC52ZXJzaW9uSWRNYXJrZXIpIHtcbiAgICAgICAgICAgIHZlcnNpb25JZE1hcmtlciA9IHJlc3VsdC52ZXJzaW9uSWRNYXJrZXJcbiAgICAgICAgICB9XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgZW5kZWQgPSB0cnVlXG4gICAgICAgIH1cbiAgICAgICAgaWYgKHJlc3VsdC5vYmplY3RzKSB7XG4gICAgICAgICAgb2JqZWN0cyA9IHJlc3VsdC5vYmplY3RzXG4gICAgICAgIH1cbiAgICAgICAgLy8gQHRzLWlnbm9yZVxuICAgICAgICByZWFkU3RyZWFtLl9yZWFkKClcbiAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICByZWFkU3RyZWFtLmVtaXQoJ2Vycm9yJywgZXJyKVxuICAgICAgfVxuICAgIH1cbiAgICByZXR1cm4gcmVhZFN0cmVhbVxuICB9XG59XG4iXSwibWFwcGluZ3MiOiI7Ozs7O0FBQUEsSUFBQUEsTUFBQSxHQUFBQyx1QkFBQSxDQUFBQyxPQUFBO0FBQ0EsSUFBQUMsRUFBQSxHQUFBRix1QkFBQSxDQUFBQyxPQUFBO0FBRUEsSUFBQUUsSUFBQSxHQUFBSCx1QkFBQSxDQUFBQyxPQUFBO0FBQ0EsSUFBQUcsS0FBQSxHQUFBSix1QkFBQSxDQUFBQyxPQUFBO0FBQ0EsSUFBQUksSUFBQSxHQUFBTCx1QkFBQSxDQUFBQyxPQUFBO0FBQ0EsSUFBQUssTUFBQSxHQUFBTix1QkFBQSxDQUFBQyxPQUFBO0FBRUEsSUFBQU0sS0FBQSxHQUFBUCx1QkFBQSxDQUFBQyxPQUFBO0FBQ0EsSUFBQU8sWUFBQSxHQUFBUCxPQUFBO0FBQ0EsSUFBQVEsY0FBQSxHQUFBUixPQUFBO0FBQ0EsSUFBQVMsT0FBQSxHQUFBVCxPQUFBO0FBQ0EsSUFBQVUsRUFBQSxHQUFBWCx1QkFBQSxDQUFBQyxPQUFBO0FBQ0EsSUFBQVcsT0FBQSxHQUFBWCxPQUFBO0FBRUEsSUFBQVksbUJBQUEsR0FBQVosT0FBQTtBQUNBLElBQUFhLE1BQUEsR0FBQWQsdUJBQUEsQ0FBQUMsT0FBQTtBQUVBLElBQUFjLFFBQUEsR0FBQWQsT0FBQTtBQVVBLElBQUFlLFFBQUEsR0FBQWYsT0FBQTtBQUNBLElBQUFnQixPQUFBLEdBQUFoQixPQUFBO0FBQ0EsSUFBQWlCLGVBQUEsR0FBQWpCLE9BQUE7QUFDQSxJQUFBa0IsV0FBQSxHQUFBbEIsT0FBQTtBQUNBLElBQUFtQixPQUFBLEdBQUFuQixPQUFBO0FBbUNBLElBQUFvQixhQUFBLEdBQUFwQixPQUFBO0FBQ0EsSUFBQXFCLFdBQUEsR0FBQXJCLE9BQUE7QUFDQSxJQUFBc0IsUUFBQSxHQUFBdEIsT0FBQTtBQUNBLElBQUF1QixTQUFBLEdBQUF2QixPQUFBO0FBRUEsSUFBQXdCLFlBQUEsR0FBQXhCLE9BQUE7QUFpREEsSUFBQXlCLFVBQUEsR0FBQTFCLHVCQUFBLENBQUFDLE9BQUE7QUFPd0IsU0FBQTBCLHlCQUFBQyxXQUFBLGVBQUFDLE9BQUEsa0NBQUFDLGlCQUFBLE9BQUFELE9BQUEsUUFBQUUsZ0JBQUEsT0FBQUYsT0FBQSxZQUFBRix3QkFBQSxZQUFBQSxDQUFBQyxXQUFBLFdBQUFBLFdBQUEsR0FBQUcsZ0JBQUEsR0FBQUQsaUJBQUEsS0FBQUYsV0FBQTtBQUFBLFNBQUE1Qix3QkFBQWdDLEdBQUEsRUFBQUosV0FBQSxTQUFBQSxXQUFBLElBQUFJLEdBQUEsSUFBQUEsR0FBQSxDQUFBQyxVQUFBLFdBQUFELEdBQUEsUUFBQUEsR0FBQSxvQkFBQUEsR0FBQSx3QkFBQUEsR0FBQSw0QkFBQUUsT0FBQSxFQUFBRixHQUFBLFVBQUFHLEtBQUEsR0FBQVIsd0JBQUEsQ0FBQUMsV0FBQSxPQUFBTyxLQUFBLElBQUFBLEtBQUEsQ0FBQUMsR0FBQSxDQUFBSixHQUFBLFlBQUFHLEtBQUEsQ0FBQUUsR0FBQSxDQUFBTCxHQUFBLFNBQUFNLE1BQUEsV0FBQUMscUJBQUEsR0FBQUMsTUFBQSxDQUFBQyxjQUFBLElBQUFELE1BQUEsQ0FBQUUsd0JBQUEsV0FBQUMsR0FBQSxJQUFBWCxHQUFBLFFBQUFXLEdBQUEsa0JBQUFILE1BQUEsQ0FBQUksU0FBQSxDQUFBQyxjQUFBLENBQUFDLElBQUEsQ0FBQWQsR0FBQSxFQUFBVyxHQUFBLFNBQUFJLElBQUEsR0FBQVIscUJBQUEsR0FBQUMsTUFBQSxDQUFBRSx3QkFBQSxDQUFBVixHQUFBLEVBQUFXLEdBQUEsY0FBQUksSUFBQSxLQUFBQSxJQUFBLENBQUFWLEdBQUEsSUFBQVUsSUFBQSxDQUFBQyxHQUFBLEtBQUFSLE1BQUEsQ0FBQUMsY0FBQSxDQUFBSCxNQUFBLEVBQUFLLEdBQUEsRUFBQUksSUFBQSxZQUFBVCxNQUFBLENBQUFLLEdBQUEsSUFBQVgsR0FBQSxDQUFBVyxHQUFBLFNBQUFMLE1BQUEsQ0FBQUosT0FBQSxHQUFBRixHQUFBLE1BQUFHLEtBQUEsSUFBQUEsS0FBQSxDQUFBYSxHQUFBLENBQUFoQixHQUFBLEVBQUFNLE1BQUEsWUFBQUEsTUFBQTtBQUd4QixNQUFNVyxHQUFHLEdBQUcsSUFBSUMsT0FBTSxDQUFDQyxPQUFPLENBQUM7RUFBRUMsVUFBVSxFQUFFO0lBQUVDLE1BQU0sRUFBRTtFQUFNLENBQUM7RUFBRUMsUUFBUSxFQUFFO0FBQUssQ0FBQyxDQUFDOztBQUVqRjtBQUNBLE1BQU1DLE9BQU8sR0FBRztFQUFFQyxPQUFPLEVBdEl6QixPQUFPLElBc0k0RDtBQUFjLENBQUM7QUFFbEYsTUFBTUMsdUJBQXVCLEdBQUcsQ0FDOUIsT0FBTyxFQUNQLElBQUksRUFDSixNQUFNLEVBQ04sU0FBUyxFQUNULGtCQUFrQixFQUNsQixLQUFLLEVBQ0wsU0FBUyxFQUNULFdBQVcsRUFDWCxRQUFRLEVBQ1Isa0JBQWtCLEVBQ2xCLEtBQUssRUFDTCxZQUFZLEVBQ1osS0FBSyxFQUNMLG9CQUFvQixFQUNwQixlQUFlLEVBQ2YsZ0JBQWdCLEVBQ2hCLFlBQVksRUFDWixrQkFBa0IsQ0FDVjtBQTJDSCxNQUFNQyxXQUFXLENBQUM7RUFjdkJDLFFBQVEsR0FBVyxFQUFFLEdBQUcsSUFBSSxHQUFHLElBQUk7RUFHekJDLGVBQWUsR0FBRyxDQUFDLEdBQUcsSUFBSSxHQUFHLElBQUksR0FBRyxJQUFJO0VBQ3hDQyxhQUFhLEdBQUcsQ0FBQyxHQUFHLElBQUksR0FBRyxJQUFJLEdBQUcsSUFBSSxHQUFHLElBQUk7RUFRdkRDLFdBQVdBLENBQUNDLE1BQXFCLEVBQUU7SUFDakM7SUFDQSxJQUFJQSxNQUFNLENBQUNDLE1BQU0sS0FBS0MsU0FBUyxFQUFFO01BQy9CLE1BQU0sSUFBSUMsS0FBSyxDQUFDLDZEQUE2RCxDQUFDO0lBQ2hGO0lBQ0E7SUFDQSxJQUFJSCxNQUFNLENBQUNJLE1BQU0sS0FBS0YsU0FBUyxFQUFFO01BQy9CRixNQUFNLENBQUNJLE1BQU0sR0FBRyxJQUFJO0lBQ3RCO0lBQ0EsSUFBSSxDQUFDSixNQUFNLENBQUNLLElBQUksRUFBRTtNQUNoQkwsTUFBTSxDQUFDSyxJQUFJLEdBQUcsQ0FBQztJQUNqQjtJQUNBO0lBQ0EsSUFBSSxDQUFDLElBQUFDLHVCQUFlLEVBQUNOLE1BQU0sQ0FBQ08sUUFBUSxDQUFDLEVBQUU7TUFDckMsTUFBTSxJQUFJeEQsTUFBTSxDQUFDeUQsb0JBQW9CLENBQUUsc0JBQXFCUixNQUFNLENBQUNPLFFBQVMsRUFBQyxDQUFDO0lBQ2hGO0lBQ0EsSUFBSSxDQUFDLElBQUFFLG1CQUFXLEVBQUNULE1BQU0sQ0FBQ0ssSUFBSSxDQUFDLEVBQUU7TUFDN0IsTUFBTSxJQUFJdEQsTUFBTSxDQUFDMkQsb0JBQW9CLENBQUUsa0JBQWlCVixNQUFNLENBQUNLLElBQUssRUFBQyxDQUFDO0lBQ3hFO0lBQ0EsSUFBSSxDQUFDLElBQUFNLGlCQUFTLEVBQUNYLE1BQU0sQ0FBQ0ksTUFBTSxDQUFDLEVBQUU7TUFDN0IsTUFBTSxJQUFJckQsTUFBTSxDQUFDMkQsb0JBQW9CLENBQ2xDLDhCQUE2QlYsTUFBTSxDQUFDSSxNQUFPLG9DQUM5QyxDQUFDO0lBQ0g7O0lBRUE7SUFDQSxJQUFJSixNQUFNLENBQUNZLE1BQU0sRUFBRTtNQUNqQixJQUFJLENBQUMsSUFBQUMsZ0JBQVEsRUFBQ2IsTUFBTSxDQUFDWSxNQUFNLENBQUMsRUFBRTtRQUM1QixNQUFNLElBQUk3RCxNQUFNLENBQUMyRCxvQkFBb0IsQ0FBRSxvQkFBbUJWLE1BQU0sQ0FBQ1ksTUFBTyxFQUFDLENBQUM7TUFDNUU7SUFDRjtJQUVBLE1BQU1FLElBQUksR0FBR2QsTUFBTSxDQUFDTyxRQUFRLENBQUNRLFdBQVcsQ0FBQyxDQUFDO0lBQzFDLElBQUlWLElBQUksR0FBR0wsTUFBTSxDQUFDSyxJQUFJO0lBQ3RCLElBQUlXLFFBQWdCO0lBQ3BCLElBQUlDLFNBQVM7SUFDYixJQUFJQyxjQUEwQjtJQUM5QjtJQUNBO0lBQ0EsSUFBSWxCLE1BQU0sQ0FBQ0ksTUFBTSxFQUFFO01BQ2pCO01BQ0FhLFNBQVMsR0FBRzVFLEtBQUs7TUFDakIyRSxRQUFRLEdBQUcsUUFBUTtNQUNuQlgsSUFBSSxHQUFHQSxJQUFJLElBQUksR0FBRztNQUNsQmEsY0FBYyxHQUFHN0UsS0FBSyxDQUFDOEUsV0FBVztJQUNwQyxDQUFDLE1BQU07TUFDTEYsU0FBUyxHQUFHN0UsSUFBSTtNQUNoQjRFLFFBQVEsR0FBRyxPQUFPO01BQ2xCWCxJQUFJLEdBQUdBLElBQUksSUFBSSxFQUFFO01BQ2pCYSxjQUFjLEdBQUc5RSxJQUFJLENBQUMrRSxXQUFXO0lBQ25DOztJQUVBO0lBQ0EsSUFBSW5CLE1BQU0sQ0FBQ2lCLFNBQVMsRUFBRTtNQUNwQixJQUFJLENBQUMsSUFBQUcsZ0JBQVEsRUFBQ3BCLE1BQU0sQ0FBQ2lCLFNBQVMsQ0FBQyxFQUFFO1FBQy9CLE1BQU0sSUFBSWxFLE1BQU0sQ0FBQzJELG9CQUFvQixDQUNsQyw0QkFBMkJWLE1BQU0sQ0FBQ2lCLFNBQVUsZ0NBQy9DLENBQUM7TUFDSDtNQUNBQSxTQUFTLEdBQUdqQixNQUFNLENBQUNpQixTQUFTO0lBQzlCOztJQUVBO0lBQ0EsSUFBSWpCLE1BQU0sQ0FBQ2tCLGNBQWMsRUFBRTtNQUN6QixJQUFJLENBQUMsSUFBQUUsZ0JBQVEsRUFBQ3BCLE1BQU0sQ0FBQ2tCLGNBQWMsQ0FBQyxFQUFFO1FBQ3BDLE1BQU0sSUFBSW5FLE1BQU0sQ0FBQzJELG9CQUFvQixDQUNsQyxnQ0FBK0JWLE1BQU0sQ0FBQ2tCLGNBQWUsZ0NBQ3hELENBQUM7TUFDSDtNQUVBQSxjQUFjLEdBQUdsQixNQUFNLENBQUNrQixjQUFjO0lBQ3hDOztJQUVBO0lBQ0E7SUFDQTtJQUNBO0lBQ0E7SUFDQSxNQUFNRyxlQUFlLEdBQUksSUFBR0MsT0FBTyxDQUFDQyxRQUFTLEtBQUlELE9BQU8sQ0FBQ0UsSUFBSyxHQUFFO0lBQ2hFLE1BQU1DLFlBQVksR0FBSSxTQUFRSixlQUFnQixhQUFZN0IsT0FBTyxDQUFDQyxPQUFRLEVBQUM7SUFDM0U7O0lBRUEsSUFBSSxDQUFDd0IsU0FBUyxHQUFHQSxTQUFTO0lBQzFCLElBQUksQ0FBQ0MsY0FBYyxHQUFHQSxjQUFjO0lBQ3BDLElBQUksQ0FBQ0osSUFBSSxHQUFHQSxJQUFJO0lBQ2hCLElBQUksQ0FBQ1QsSUFBSSxHQUFHQSxJQUFJO0lBQ2hCLElBQUksQ0FBQ1csUUFBUSxHQUFHQSxRQUFRO0lBQ3hCLElBQUksQ0FBQ1UsU0FBUyxHQUFJLEdBQUVELFlBQWEsRUFBQzs7SUFFbEM7SUFDQSxJQUFJekIsTUFBTSxDQUFDMkIsU0FBUyxLQUFLekIsU0FBUyxFQUFFO01BQ2xDLElBQUksQ0FBQ3lCLFNBQVMsR0FBRyxJQUFJO0lBQ3ZCLENBQUMsTUFBTTtNQUNMLElBQUksQ0FBQ0EsU0FBUyxHQUFHM0IsTUFBTSxDQUFDMkIsU0FBUztJQUNuQztJQUVBLElBQUksQ0FBQ0MsU0FBUyxHQUFHNUIsTUFBTSxDQUFDNEIsU0FBUyxJQUFJLEVBQUU7SUFDdkMsSUFBSSxDQUFDQyxTQUFTLEdBQUc3QixNQUFNLENBQUM2QixTQUFTLElBQUksRUFBRTtJQUN2QyxJQUFJLENBQUNDLFlBQVksR0FBRzlCLE1BQU0sQ0FBQzhCLFlBQVk7SUFDdkMsSUFBSSxDQUFDQyxTQUFTLEdBQUcsQ0FBQyxJQUFJLENBQUNILFNBQVMsSUFBSSxDQUFDLElBQUksQ0FBQ0MsU0FBUztJQUVuRCxJQUFJN0IsTUFBTSxDQUFDZ0MsbUJBQW1CLEVBQUU7TUFDOUIsSUFBSSxDQUFDRCxTQUFTLEdBQUcsS0FBSztNQUN0QixJQUFJLENBQUNDLG1CQUFtQixHQUFHaEMsTUFBTSxDQUFDZ0MsbUJBQW1CO0lBQ3ZEO0lBRUEsSUFBSSxDQUFDQyxTQUFTLEdBQUcsQ0FBQyxDQUFDO0lBQ25CLElBQUlqQyxNQUFNLENBQUNZLE1BQU0sRUFBRTtNQUNqQixJQUFJLENBQUNBLE1BQU0sR0FBR1osTUFBTSxDQUFDWSxNQUFNO0lBQzdCO0lBRUEsSUFBSVosTUFBTSxDQUFDSixRQUFRLEVBQUU7TUFDbkIsSUFBSSxDQUFDQSxRQUFRLEdBQUdJLE1BQU0sQ0FBQ0osUUFBUTtNQUMvQixJQUFJLENBQUNzQyxnQkFBZ0IsR0FBRyxJQUFJO0lBQzlCO0lBQ0EsSUFBSSxJQUFJLENBQUN0QyxRQUFRLEdBQUcsQ0FBQyxHQUFHLElBQUksR0FBRyxJQUFJLEVBQUU7TUFDbkMsTUFBTSxJQUFJN0MsTUFBTSxDQUFDMkQsb0JBQW9CLENBQUUsc0NBQXFDLENBQUM7SUFDL0U7SUFDQSxJQUFJLElBQUksQ0FBQ2QsUUFBUSxHQUFHLENBQUMsR0FBRyxJQUFJLEdBQUcsSUFBSSxHQUFHLElBQUksRUFBRTtNQUMxQyxNQUFNLElBQUk3QyxNQUFNLENBQUMyRCxvQkFBb0IsQ0FBRSxtQ0FBa0MsQ0FBQztJQUM1RTs7SUFFQTtJQUNBO0lBQ0E7SUFDQSxJQUFJLENBQUN5QixZQUFZLEdBQUcsQ0FBQyxJQUFJLENBQUNKLFNBQVMsSUFBSSxDQUFDL0IsTUFBTSxDQUFDSSxNQUFNO0lBRXJELElBQUksQ0FBQ2dDLG9CQUFvQixHQUFHcEMsTUFBTSxDQUFDb0Msb0JBQW9CLElBQUlsQyxTQUFTO0lBQ3BFLElBQUksQ0FBQ21DLFVBQVUsR0FBRyxDQUFDLENBQUM7SUFDcEIsSUFBSSxDQUFDQyxnQkFBZ0IsR0FBRyxJQUFJQyxzQkFBVSxDQUFDLElBQUksQ0FBQztFQUM5QztFQUNBO0FBQ0Y7QUFDQTtFQUNFLElBQUlDLFVBQVVBLENBQUEsRUFBRztJQUNmLE9BQU8sSUFBSSxDQUFDRixnQkFBZ0I7RUFDOUI7O0VBRUE7QUFDRjtBQUNBO0VBQ0VHLHVCQUF1QkEsQ0FBQ2xDLFFBQWdCLEVBQUU7SUFDeEMsSUFBSSxDQUFDNkIsb0JBQW9CLEdBQUc3QixRQUFRO0VBQ3RDOztFQUVBO0FBQ0Y7QUFDQTtFQUNTbUMsaUJBQWlCQSxDQUFDQyxPQUE2RSxFQUFFO0lBQ3RHLElBQUksQ0FBQyxJQUFBdkIsZ0JBQVEsRUFBQ3VCLE9BQU8sQ0FBQyxFQUFFO01BQ3RCLE1BQU0sSUFBSUMsU0FBUyxDQUFDLDRDQUE0QyxDQUFDO0lBQ25FO0lBQ0EsSUFBSSxDQUFDUCxVQUFVLEdBQUdRLE9BQUMsQ0FBQ0MsSUFBSSxDQUFDSCxPQUFPLEVBQUVqRCx1QkFBdUIsQ0FBQztFQUM1RDs7RUFFQTtBQUNGO0FBQ0E7RUFDVXFELDBCQUEwQkEsQ0FBQ0MsVUFBbUIsRUFBRUMsVUFBbUIsRUFBRTtJQUMzRSxJQUFJLENBQUMsSUFBQUMsZUFBTyxFQUFDLElBQUksQ0FBQ2Qsb0JBQW9CLENBQUMsSUFBSSxDQUFDLElBQUFjLGVBQU8sRUFBQ0YsVUFBVSxDQUFDLElBQUksQ0FBQyxJQUFBRSxlQUFPLEVBQUNELFVBQVUsQ0FBQyxFQUFFO01BQ3ZGO01BQ0E7TUFDQSxJQUFJRCxVQUFVLENBQUNHLFFBQVEsQ0FBQyxHQUFHLENBQUMsRUFBRTtRQUM1QixNQUFNLElBQUloRCxLQUFLLENBQUUsbUVBQWtFNkMsVUFBVyxFQUFDLENBQUM7TUFDbEc7TUFDQTtNQUNBO01BQ0E7TUFDQSxPQUFPLElBQUksQ0FBQ1osb0JBQW9CO0lBQ2xDO0lBQ0EsT0FBTyxLQUFLO0VBQ2Q7O0VBRUE7QUFDRjtBQUNBO0FBQ0E7QUFDQTtFQUNFZ0IsVUFBVUEsQ0FBQ0MsT0FBZSxFQUFFQyxVQUFrQixFQUFFO0lBQzlDLElBQUksQ0FBQyxJQUFBekMsZ0JBQVEsRUFBQ3dDLE9BQU8sQ0FBQyxFQUFFO01BQ3RCLE1BQU0sSUFBSVQsU0FBUyxDQUFFLG9CQUFtQlMsT0FBUSxFQUFDLENBQUM7SUFDcEQ7SUFDQSxJQUFJQSxPQUFPLENBQUNFLElBQUksQ0FBQyxDQUFDLEtBQUssRUFBRSxFQUFFO01BQ3pCLE1BQU0sSUFBSXhHLE1BQU0sQ0FBQzJELG9CQUFvQixDQUFDLGdDQUFnQyxDQUFDO0lBQ3pFO0lBQ0EsSUFBSSxDQUFDLElBQUFHLGdCQUFRLEVBQUN5QyxVQUFVLENBQUMsRUFBRTtNQUN6QixNQUFNLElBQUlWLFNBQVMsQ0FBRSx1QkFBc0JVLFVBQVcsRUFBQyxDQUFDO0lBQzFEO0lBQ0EsSUFBSUEsVUFBVSxDQUFDQyxJQUFJLENBQUMsQ0FBQyxLQUFLLEVBQUUsRUFBRTtNQUM1QixNQUFNLElBQUl4RyxNQUFNLENBQUMyRCxvQkFBb0IsQ0FBQyxtQ0FBbUMsQ0FBQztJQUM1RTtJQUNBLElBQUksQ0FBQ2dCLFNBQVMsR0FBSSxHQUFFLElBQUksQ0FBQ0EsU0FBVSxJQUFHMkIsT0FBUSxJQUFHQyxVQUFXLEVBQUM7RUFDL0Q7O0VBRUE7QUFDRjtBQUNBO0FBQ0E7RUFDWUUsaUJBQWlCQSxDQUN6QkMsSUFFQyxFQUlEO0lBQ0EsTUFBTUMsTUFBTSxHQUFHRCxJQUFJLENBQUNDLE1BQU07SUFDMUIsTUFBTTlDLE1BQU0sR0FBRzZDLElBQUksQ0FBQzdDLE1BQU07SUFDMUIsTUFBTW9DLFVBQVUsR0FBR1MsSUFBSSxDQUFDVCxVQUFVO0lBQ2xDLElBQUlDLFVBQVUsR0FBR1EsSUFBSSxDQUFDUixVQUFVO0lBQ2hDLE1BQU1VLE9BQU8sR0FBR0YsSUFBSSxDQUFDRSxPQUFPO0lBQzVCLE1BQU1DLEtBQUssR0FBR0gsSUFBSSxDQUFDRyxLQUFLO0lBRXhCLElBQUl2QixVQUFVLEdBQUc7TUFDZnFCLE1BQU07TUFDTkMsT0FBTyxFQUFFLENBQUMsQ0FBbUI7TUFDN0IzQyxRQUFRLEVBQUUsSUFBSSxDQUFDQSxRQUFRO01BQ3ZCO01BQ0E2QyxLQUFLLEVBQUUsSUFBSSxDQUFDM0M7SUFDZCxDQUFDOztJQUVEO0lBQ0EsSUFBSTRDLGdCQUFnQjtJQUNwQixJQUFJZCxVQUFVLEVBQUU7TUFDZGMsZ0JBQWdCLEdBQUcsSUFBQUMsMEJBQWtCLEVBQUMsSUFBSSxDQUFDakQsSUFBSSxFQUFFLElBQUksQ0FBQ0UsUUFBUSxFQUFFZ0MsVUFBVSxFQUFFLElBQUksQ0FBQ3JCLFNBQVMsQ0FBQztJQUM3RjtJQUVBLElBQUlyRixJQUFJLEdBQUcsR0FBRztJQUNkLElBQUl3RSxJQUFJLEdBQUcsSUFBSSxDQUFDQSxJQUFJO0lBRXBCLElBQUlULElBQXdCO0lBQzVCLElBQUksSUFBSSxDQUFDQSxJQUFJLEVBQUU7TUFDYkEsSUFBSSxHQUFHLElBQUksQ0FBQ0EsSUFBSTtJQUNsQjtJQUVBLElBQUk0QyxVQUFVLEVBQUU7TUFDZEEsVUFBVSxHQUFHLElBQUFlLHlCQUFpQixFQUFDZixVQUFVLENBQUM7SUFDNUM7O0lBRUE7SUFDQSxJQUFJLElBQUFnQix3QkFBZ0IsRUFBQ25ELElBQUksQ0FBQyxFQUFFO01BQzFCLE1BQU1vRCxrQkFBa0IsR0FBRyxJQUFJLENBQUNuQiwwQkFBMEIsQ0FBQ0MsVUFBVSxFQUFFQyxVQUFVLENBQUM7TUFDbEYsSUFBSWlCLGtCQUFrQixFQUFFO1FBQ3RCcEQsSUFBSSxHQUFJLEdBQUVvRCxrQkFBbUIsRUFBQztNQUNoQyxDQUFDLE1BQU07UUFDTHBELElBQUksR0FBRyxJQUFBcUQsMEJBQWEsRUFBQ3ZELE1BQU0sQ0FBQztNQUM5QjtJQUNGO0lBRUEsSUFBSWtELGdCQUFnQixJQUFJLENBQUNMLElBQUksQ0FBQzlCLFNBQVMsRUFBRTtNQUN2QztNQUNBO01BQ0E7TUFDQTtNQUNBO01BQ0EsSUFBSXFCLFVBQVUsRUFBRTtRQUNkbEMsSUFBSSxHQUFJLEdBQUVrQyxVQUFXLElBQUdsQyxJQUFLLEVBQUM7TUFDaEM7TUFDQSxJQUFJbUMsVUFBVSxFQUFFO1FBQ2QzRyxJQUFJLEdBQUksSUFBRzJHLFVBQVcsRUFBQztNQUN6QjtJQUNGLENBQUMsTUFBTTtNQUNMO01BQ0E7TUFDQTtNQUNBLElBQUlELFVBQVUsRUFBRTtRQUNkMUcsSUFBSSxHQUFJLElBQUcwRyxVQUFXLEVBQUM7TUFDekI7TUFDQSxJQUFJQyxVQUFVLEVBQUU7UUFDZDNHLElBQUksR0FBSSxJQUFHMEcsVUFBVyxJQUFHQyxVQUFXLEVBQUM7TUFDdkM7SUFDRjtJQUVBLElBQUlXLEtBQUssRUFBRTtNQUNUdEgsSUFBSSxJQUFLLElBQUdzSCxLQUFNLEVBQUM7SUFDckI7SUFDQXZCLFVBQVUsQ0FBQ3NCLE9BQU8sQ0FBQzdDLElBQUksR0FBR0EsSUFBSTtJQUM5QixJQUFLdUIsVUFBVSxDQUFDckIsUUFBUSxLQUFLLE9BQU8sSUFBSVgsSUFBSSxLQUFLLEVBQUUsSUFBTWdDLFVBQVUsQ0FBQ3JCLFFBQVEsS0FBSyxRQUFRLElBQUlYLElBQUksS0FBSyxHQUFJLEVBQUU7TUFDMUdnQyxVQUFVLENBQUNzQixPQUFPLENBQUM3QyxJQUFJLEdBQUcsSUFBQXNELDBCQUFZLEVBQUN0RCxJQUFJLEVBQUVULElBQUksQ0FBQztJQUNwRDtJQUVBZ0MsVUFBVSxDQUFDc0IsT0FBTyxDQUFDLFlBQVksQ0FBQyxHQUFHLElBQUksQ0FBQ2pDLFNBQVM7SUFDakQsSUFBSWlDLE9BQU8sRUFBRTtNQUNYO01BQ0EsS0FBSyxNQUFNLENBQUNVLENBQUMsRUFBRUMsQ0FBQyxDQUFDLElBQUk3RixNQUFNLENBQUM4RixPQUFPLENBQUNaLE9BQU8sQ0FBQyxFQUFFO1FBQzVDdEIsVUFBVSxDQUFDc0IsT0FBTyxDQUFDVSxDQUFDLENBQUN0RCxXQUFXLENBQUMsQ0FBQyxDQUFDLEdBQUd1RCxDQUFDO01BQ3pDO0lBQ0Y7O0lBRUE7SUFDQWpDLFVBQVUsR0FBRzVELE1BQU0sQ0FBQytGLE1BQU0sQ0FBQyxDQUFDLENBQUMsRUFBRSxJQUFJLENBQUNuQyxVQUFVLEVBQUVBLFVBQVUsQ0FBQztJQUUzRCxPQUFPO01BQ0wsR0FBR0EsVUFBVTtNQUNic0IsT0FBTyxFQUFFZCxPQUFDLENBQUM0QixTQUFTLENBQUM1QixPQUFDLENBQUM2QixNQUFNLENBQUNyQyxVQUFVLENBQUNzQixPQUFPLEVBQUVnQixpQkFBUyxDQUFDLEVBQUdMLENBQUMsSUFBS0EsQ0FBQyxDQUFDTSxRQUFRLENBQUMsQ0FBQyxDQUFDO01BQ2xGOUQsSUFBSTtNQUNKVCxJQUFJO01BQ0ovRDtJQUNGLENBQUM7RUFDSDtFQUVBLE1BQWF1SSxzQkFBc0JBLENBQUM3QyxtQkFBdUMsRUFBRTtJQUMzRSxJQUFJLEVBQUVBLG1CQUFtQixZQUFZOEMsc0NBQWtCLENBQUMsRUFBRTtNQUN4RCxNQUFNLElBQUkzRSxLQUFLLENBQUMsb0VBQW9FLENBQUM7SUFDdkY7SUFDQSxJQUFJLENBQUM2QixtQkFBbUIsR0FBR0EsbUJBQW1CO0lBQzlDLE1BQU0sSUFBSSxDQUFDK0Msb0JBQW9CLENBQUMsQ0FBQztFQUNuQztFQUVBLE1BQWNBLG9CQUFvQkEsQ0FBQSxFQUFHO0lBQ25DLElBQUksSUFBSSxDQUFDL0MsbUJBQW1CLEVBQUU7TUFDNUIsSUFBSTtRQUNGLE1BQU1nRCxlQUFlLEdBQUcsTUFBTSxJQUFJLENBQUNoRCxtQkFBbUIsQ0FBQ2lELGNBQWMsQ0FBQyxDQUFDO1FBQ3ZFLElBQUksQ0FBQ3JELFNBQVMsR0FBR29ELGVBQWUsQ0FBQ0UsWUFBWSxDQUFDLENBQUM7UUFDL0MsSUFBSSxDQUFDckQsU0FBUyxHQUFHbUQsZUFBZSxDQUFDRyxZQUFZLENBQUMsQ0FBQztRQUMvQyxJQUFJLENBQUNyRCxZQUFZLEdBQUdrRCxlQUFlLENBQUNJLGVBQWUsQ0FBQyxDQUFDO01BQ3ZELENBQUMsQ0FBQyxPQUFPQyxDQUFDLEVBQUU7UUFDVixNQUFNLElBQUlsRixLQUFLLENBQUUsOEJBQTZCa0YsQ0FBRSxFQUFDLEVBQUU7VUFBRUMsS0FBSyxFQUFFRDtRQUFFLENBQUMsQ0FBQztNQUNsRTtJQUNGO0VBQ0Y7RUFJQTtBQUNGO0FBQ0E7RUFDVUUsT0FBT0EsQ0FBQ2xELFVBQW9CLEVBQUVtRCxRQUFxQyxFQUFFQyxHQUFhLEVBQUU7SUFDMUY7SUFDQSxJQUFJLENBQUMsSUFBSSxDQUFDQyxTQUFTLEVBQUU7TUFDbkI7SUFDRjtJQUNBLElBQUksQ0FBQyxJQUFBdEUsZ0JBQVEsRUFBQ2lCLFVBQVUsQ0FBQyxFQUFFO01BQ3pCLE1BQU0sSUFBSU8sU0FBUyxDQUFDLHVDQUF1QyxDQUFDO0lBQzlEO0lBQ0EsSUFBSTRDLFFBQVEsSUFBSSxDQUFDLElBQUFHLHdCQUFnQixFQUFDSCxRQUFRLENBQUMsRUFBRTtNQUMzQyxNQUFNLElBQUk1QyxTQUFTLENBQUMscUNBQXFDLENBQUM7SUFDNUQ7SUFDQSxJQUFJNkMsR0FBRyxJQUFJLEVBQUVBLEdBQUcsWUFBWXRGLEtBQUssQ0FBQyxFQUFFO01BQ2xDLE1BQU0sSUFBSXlDLFNBQVMsQ0FBQywrQkFBK0IsQ0FBQztJQUN0RDtJQUNBLE1BQU04QyxTQUFTLEdBQUcsSUFBSSxDQUFDQSxTQUFTO0lBQ2hDLE1BQU1FLFVBQVUsR0FBSWpDLE9BQXVCLElBQUs7TUFDOUNsRixNQUFNLENBQUM4RixPQUFPLENBQUNaLE9BQU8sQ0FBQyxDQUFDa0MsT0FBTyxDQUFDLENBQUMsQ0FBQ3hCLENBQUMsRUFBRUMsQ0FBQyxDQUFDLEtBQUs7UUFDMUMsSUFBSUQsQ0FBQyxJQUFJLGVBQWUsRUFBRTtVQUN4QixJQUFJLElBQUF4RCxnQkFBUSxFQUFDeUQsQ0FBQyxDQUFDLEVBQUU7WUFDZixNQUFNd0IsUUFBUSxHQUFHLElBQUlDLE1BQU0sQ0FBQyx1QkFBdUIsQ0FBQztZQUNwRHpCLENBQUMsR0FBR0EsQ0FBQyxDQUFDMEIsT0FBTyxDQUFDRixRQUFRLEVBQUUsd0JBQXdCLENBQUM7VUFDbkQ7UUFDRjtRQUNBSixTQUFTLENBQUNPLEtBQUssQ0FBRSxHQUFFNUIsQ0FBRSxLQUFJQyxDQUFFLElBQUcsQ0FBQztNQUNqQyxDQUFDLENBQUM7TUFDRm9CLFNBQVMsQ0FBQ08sS0FBSyxDQUFDLElBQUksQ0FBQztJQUN2QixDQUFDO0lBQ0RQLFNBQVMsQ0FBQ08sS0FBSyxDQUFFLFlBQVc1RCxVQUFVLENBQUNxQixNQUFPLElBQUdyQixVQUFVLENBQUMvRixJQUFLLElBQUcsQ0FBQztJQUNyRXNKLFVBQVUsQ0FBQ3ZELFVBQVUsQ0FBQ3NCLE9BQU8sQ0FBQztJQUM5QixJQUFJNkIsUUFBUSxFQUFFO01BQ1osSUFBSSxDQUFDRSxTQUFTLENBQUNPLEtBQUssQ0FBRSxhQUFZVCxRQUFRLENBQUNVLFVBQVcsSUFBRyxDQUFDO01BQzFETixVQUFVLENBQUNKLFFBQVEsQ0FBQzdCLE9BQXlCLENBQUM7SUFDaEQ7SUFDQSxJQUFJOEIsR0FBRyxFQUFFO01BQ1BDLFNBQVMsQ0FBQ08sS0FBSyxDQUFDLGVBQWUsQ0FBQztNQUNoQyxNQUFNRSxPQUFPLEdBQUdDLElBQUksQ0FBQ0MsU0FBUyxDQUFDWixHQUFHLEVBQUUsSUFBSSxFQUFFLElBQUksQ0FBQztNQUMvQ0MsU0FBUyxDQUFDTyxLQUFLLENBQUUsR0FBRUUsT0FBUSxJQUFHLENBQUM7SUFDakM7RUFDRjs7RUFFQTtBQUNGO0FBQ0E7RUFDU0csT0FBT0EsQ0FBQy9KLE1BQXdCLEVBQUU7SUFDdkMsSUFBSSxDQUFDQSxNQUFNLEVBQUU7TUFDWEEsTUFBTSxHQUFHK0UsT0FBTyxDQUFDaUYsTUFBTTtJQUN6QjtJQUNBLElBQUksQ0FBQ2IsU0FBUyxHQUFHbkosTUFBTTtFQUN6Qjs7RUFFQTtBQUNGO0FBQ0E7RUFDU2lLLFFBQVFBLENBQUEsRUFBRztJQUNoQixJQUFJLENBQUNkLFNBQVMsR0FBR3hGLFNBQVM7RUFDNUI7O0VBRUE7QUFDRjtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7RUFDRSxNQUFNdUcsZ0JBQWdCQSxDQUNwQjlELE9BQXNCLEVBQ3RCK0QsT0FBZSxHQUFHLEVBQUUsRUFDcEJDLGFBQXVCLEdBQUcsQ0FBQyxHQUFHLENBQUMsRUFDL0IvRixNQUFNLEdBQUcsRUFBRSxFQUNvQjtJQUMvQixJQUFJLENBQUMsSUFBQVEsZ0JBQVEsRUFBQ3VCLE9BQU8sQ0FBQyxFQUFFO01BQ3RCLE1BQU0sSUFBSUMsU0FBUyxDQUFDLG9DQUFvQyxDQUFDO0lBQzNEO0lBQ0EsSUFBSSxDQUFDLElBQUEvQixnQkFBUSxFQUFDNkYsT0FBTyxDQUFDLElBQUksQ0FBQyxJQUFBdEYsZ0JBQVEsRUFBQ3NGLE9BQU8sQ0FBQyxFQUFFO01BQzVDO01BQ0EsTUFBTSxJQUFJOUQsU0FBUyxDQUFDLGdEQUFnRCxDQUFDO0lBQ3ZFO0lBQ0ErRCxhQUFhLENBQUNkLE9BQU8sQ0FBRUssVUFBVSxJQUFLO01BQ3BDLElBQUksQ0FBQyxJQUFBVSxnQkFBUSxFQUFDVixVQUFVLENBQUMsRUFBRTtRQUN6QixNQUFNLElBQUl0RCxTQUFTLENBQUMsdUNBQXVDLENBQUM7TUFDOUQ7SUFDRixDQUFDLENBQUM7SUFDRixJQUFJLENBQUMsSUFBQS9CLGdCQUFRLEVBQUNELE1BQU0sQ0FBQyxFQUFFO01BQ3JCLE1BQU0sSUFBSWdDLFNBQVMsQ0FBQyxtQ0FBbUMsQ0FBQztJQUMxRDtJQUNBLElBQUksQ0FBQ0QsT0FBTyxDQUFDZ0IsT0FBTyxFQUFFO01BQ3BCaEIsT0FBTyxDQUFDZ0IsT0FBTyxHQUFHLENBQUMsQ0FBQztJQUN0QjtJQUNBLElBQUloQixPQUFPLENBQUNlLE1BQU0sS0FBSyxNQUFNLElBQUlmLE9BQU8sQ0FBQ2UsTUFBTSxLQUFLLEtBQUssSUFBSWYsT0FBTyxDQUFDZSxNQUFNLEtBQUssUUFBUSxFQUFFO01BQ3hGZixPQUFPLENBQUNnQixPQUFPLENBQUMsZ0JBQWdCLENBQUMsR0FBRytDLE9BQU8sQ0FBQ0csTUFBTSxDQUFDakMsUUFBUSxDQUFDLENBQUM7SUFDL0Q7SUFDQSxNQUFNa0MsU0FBUyxHQUFHLElBQUksQ0FBQzNFLFlBQVksR0FBRyxJQUFBNEUsZ0JBQVEsRUFBQ0wsT0FBTyxDQUFDLEdBQUcsRUFBRTtJQUM1RCxPQUFPLElBQUksQ0FBQ00sc0JBQXNCLENBQUNyRSxPQUFPLEVBQUUrRCxPQUFPLEVBQUVJLFNBQVMsRUFBRUgsYUFBYSxFQUFFL0YsTUFBTSxDQUFDO0VBQ3hGOztFQUVBO0FBQ0Y7QUFDQTtBQUNBO0FBQ0E7RUFDRSxNQUFNcUcsb0JBQW9CQSxDQUN4QnRFLE9BQXNCLEVBQ3RCK0QsT0FBZSxHQUFHLEVBQUUsRUFDcEJRLFdBQXFCLEdBQUcsQ0FBQyxHQUFHLENBQUMsRUFDN0J0RyxNQUFNLEdBQUcsRUFBRSxFQUNnQztJQUMzQyxNQUFNdUcsR0FBRyxHQUFHLE1BQU0sSUFBSSxDQUFDVixnQkFBZ0IsQ0FBQzlELE9BQU8sRUFBRStELE9BQU8sRUFBRVEsV0FBVyxFQUFFdEcsTUFBTSxDQUFDO0lBQzlFLE1BQU0sSUFBQXdHLHVCQUFhLEVBQUNELEdBQUcsQ0FBQztJQUN4QixPQUFPQSxHQUFHO0VBQ1o7O0VBRUE7QUFDRjtBQUNBO0FBQ0E7QUFDQTtBQUNBO0VBQ0UsTUFBTUgsc0JBQXNCQSxDQUMxQnJFLE9BQXNCLEVBQ3RCMEUsSUFBOEIsRUFDOUJQLFNBQWlCLEVBQ2pCSSxXQUFxQixFQUNyQnRHLE1BQWMsRUFDaUI7SUFDL0IsSUFBSSxDQUFDLElBQUFRLGdCQUFRLEVBQUN1QixPQUFPLENBQUMsRUFBRTtNQUN0QixNQUFNLElBQUlDLFNBQVMsQ0FBQyxvQ0FBb0MsQ0FBQztJQUMzRDtJQUNBLElBQUksRUFBRTBFLE1BQU0sQ0FBQ0MsUUFBUSxDQUFDRixJQUFJLENBQUMsSUFBSSxPQUFPQSxJQUFJLEtBQUssUUFBUSxJQUFJLElBQUExQix3QkFBZ0IsRUFBQzBCLElBQUksQ0FBQyxDQUFDLEVBQUU7TUFDbEYsTUFBTSxJQUFJdEssTUFBTSxDQUFDMkQsb0JBQW9CLENBQ2xDLDZEQUE0RCxPQUFPMkcsSUFBSyxVQUMzRSxDQUFDO0lBQ0g7SUFDQSxJQUFJLENBQUMsSUFBQXhHLGdCQUFRLEVBQUNpRyxTQUFTLENBQUMsRUFBRTtNQUN4QixNQUFNLElBQUlsRSxTQUFTLENBQUMsc0NBQXNDLENBQUM7SUFDN0Q7SUFDQXNFLFdBQVcsQ0FBQ3JCLE9BQU8sQ0FBRUssVUFBVSxJQUFLO01BQ2xDLElBQUksQ0FBQyxJQUFBVSxnQkFBUSxFQUFDVixVQUFVLENBQUMsRUFBRTtRQUN6QixNQUFNLElBQUl0RCxTQUFTLENBQUMsdUNBQXVDLENBQUM7TUFDOUQ7SUFDRixDQUFDLENBQUM7SUFDRixJQUFJLENBQUMsSUFBQS9CLGdCQUFRLEVBQUNELE1BQU0sQ0FBQyxFQUFFO01BQ3JCLE1BQU0sSUFBSWdDLFNBQVMsQ0FBQyxtQ0FBbUMsQ0FBQztJQUMxRDtJQUNBO0lBQ0EsSUFBSSxDQUFDLElBQUksQ0FBQ1QsWUFBWSxJQUFJMkUsU0FBUyxDQUFDRCxNQUFNLEtBQUssQ0FBQyxFQUFFO01BQ2hELE1BQU0sSUFBSTlKLE1BQU0sQ0FBQzJELG9CQUFvQixDQUFFLGdFQUErRCxDQUFDO0lBQ3pHO0lBQ0E7SUFDQSxJQUFJLElBQUksQ0FBQ3lCLFlBQVksSUFBSTJFLFNBQVMsQ0FBQ0QsTUFBTSxLQUFLLEVBQUUsRUFBRTtNQUNoRCxNQUFNLElBQUk5SixNQUFNLENBQUMyRCxvQkFBb0IsQ0FBRSx1QkFBc0JvRyxTQUFVLEVBQUMsQ0FBQztJQUMzRTtJQUVBLE1BQU0sSUFBSSxDQUFDL0Isb0JBQW9CLENBQUMsQ0FBQzs7SUFFakM7SUFDQW5FLE1BQU0sR0FBR0EsTUFBTSxLQUFLLE1BQU0sSUFBSSxDQUFDNEcsb0JBQW9CLENBQUM3RSxPQUFPLENBQUNLLFVBQVcsQ0FBQyxDQUFDO0lBRXpFLE1BQU1YLFVBQVUsR0FBRyxJQUFJLENBQUNtQixpQkFBaUIsQ0FBQztNQUFFLEdBQUdiLE9BQU87TUFBRS9CO0lBQU8sQ0FBQyxDQUFDO0lBQ2pFLElBQUksQ0FBQyxJQUFJLENBQUNtQixTQUFTLEVBQUU7TUFDbkI7TUFDQSxJQUFJLENBQUMsSUFBSSxDQUFDSSxZQUFZLEVBQUU7UUFDdEIyRSxTQUFTLEdBQUcsa0JBQWtCO01BQ2hDO01BQ0EsTUFBTVcsSUFBSSxHQUFHLElBQUlDLElBQUksQ0FBQyxDQUFDO01BQ3ZCckYsVUFBVSxDQUFDc0IsT0FBTyxDQUFDLFlBQVksQ0FBQyxHQUFHLElBQUFnRSxvQkFBWSxFQUFDRixJQUFJLENBQUM7TUFDckRwRixVQUFVLENBQUNzQixPQUFPLENBQUMsc0JBQXNCLENBQUMsR0FBR21ELFNBQVM7TUFDdEQsSUFBSSxJQUFJLENBQUNoRixZQUFZLEVBQUU7UUFDckJPLFVBQVUsQ0FBQ3NCLE9BQU8sQ0FBQyxzQkFBc0IsQ0FBQyxHQUFHLElBQUksQ0FBQzdCLFlBQVk7TUFDaEU7TUFDQU8sVUFBVSxDQUFDc0IsT0FBTyxDQUFDaUUsYUFBYSxHQUFHLElBQUFDLGVBQU0sRUFBQ3hGLFVBQVUsRUFBRSxJQUFJLENBQUNULFNBQVMsRUFBRSxJQUFJLENBQUNDLFNBQVMsRUFBRWpCLE1BQU0sRUFBRTZHLElBQUksRUFBRVgsU0FBUyxDQUFDO0lBQ2hIO0lBRUEsTUFBTXRCLFFBQVEsR0FBRyxNQUFNLElBQUFzQyx5QkFBZ0IsRUFBQyxJQUFJLENBQUM3RyxTQUFTLEVBQUVvQixVQUFVLEVBQUVnRixJQUFJLENBQUM7SUFDekUsSUFBSSxDQUFDN0IsUUFBUSxDQUFDVSxVQUFVLEVBQUU7TUFDeEIsTUFBTSxJQUFJL0YsS0FBSyxDQUFDLHlDQUF5QyxDQUFDO0lBQzVEO0lBRUEsSUFBSSxDQUFDK0csV0FBVyxDQUFDL0QsUUFBUSxDQUFDcUMsUUFBUSxDQUFDVSxVQUFVLENBQUMsRUFBRTtNQUM5QztNQUNBO01BQ0E7TUFDQTtNQUNBO01BQ0EsT0FBTyxJQUFJLENBQUNqRSxTQUFTLENBQUNVLE9BQU8sQ0FBQ0ssVUFBVSxDQUFFO01BRTFDLE1BQU15QyxHQUFHLEdBQUcsTUFBTTlILFVBQVUsQ0FBQ29LLGtCQUFrQixDQUFDdkMsUUFBUSxDQUFDO01BQ3pELElBQUksQ0FBQ0QsT0FBTyxDQUFDbEQsVUFBVSxFQUFFbUQsUUFBUSxFQUFFQyxHQUFHLENBQUM7TUFDdkMsTUFBTUEsR0FBRztJQUNYO0lBRUEsSUFBSSxDQUFDRixPQUFPLENBQUNsRCxVQUFVLEVBQUVtRCxRQUFRLENBQUM7SUFFbEMsT0FBT0EsUUFBUTtFQUNqQjs7RUFFQTtBQUNGO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7RUFDRSxNQUFNZ0Msb0JBQW9CQSxDQUFDeEUsVUFBa0IsRUFBbUI7SUFDOUQsSUFBSSxDQUFDLElBQUFnRix5QkFBaUIsRUFBQ2hGLFVBQVUsQ0FBQyxFQUFFO01BQ2xDLE1BQU0sSUFBSWpHLE1BQU0sQ0FBQ2tMLHNCQUFzQixDQUFFLHlCQUF3QmpGLFVBQVcsRUFBQyxDQUFDO0lBQ2hGOztJQUVBO0lBQ0EsSUFBSSxJQUFJLENBQUNwQyxNQUFNLEVBQUU7TUFDZixPQUFPLElBQUksQ0FBQ0EsTUFBTTtJQUNwQjtJQUVBLE1BQU1zSCxNQUFNLEdBQUcsSUFBSSxDQUFDakcsU0FBUyxDQUFDZSxVQUFVLENBQUM7SUFDekMsSUFBSWtGLE1BQU0sRUFBRTtNQUNWLE9BQU9BLE1BQU07SUFDZjtJQUVBLE1BQU1DLGtCQUFrQixHQUFHLE1BQU8zQyxRQUE4QixJQUFLO01BQ25FLE1BQU02QixJQUFJLEdBQUcsTUFBTSxJQUFBZSxzQkFBWSxFQUFDNUMsUUFBUSxDQUFDO01BQ3pDLE1BQU01RSxNQUFNLEdBQUdqRCxVQUFVLENBQUMwSyxpQkFBaUIsQ0FBQ2hCLElBQUksQ0FBQyxJQUFJaUIsdUJBQWM7TUFDbkUsSUFBSSxDQUFDckcsU0FBUyxDQUFDZSxVQUFVLENBQUMsR0FBR3BDLE1BQU07TUFDbkMsT0FBT0EsTUFBTTtJQUNmLENBQUM7SUFFRCxNQUFNOEMsTUFBTSxHQUFHLEtBQUs7SUFDcEIsTUFBTUUsS0FBSyxHQUFHLFVBQVU7SUFDeEI7SUFDQTtJQUNBO0lBQ0E7SUFDQTtJQUNBO0lBQ0E7SUFDQTtJQUNBO0lBQ0E7SUFDQTtJQUNBLE1BQU1qQyxTQUFTLEdBQUcsSUFBSSxDQUFDQSxTQUFTLElBQUksQ0FBQzRHLHdCQUFTO0lBQzlDLElBQUkzSCxNQUFjO0lBQ2xCLElBQUk7TUFDRixNQUFNdUcsR0FBRyxHQUFHLE1BQU0sSUFBSSxDQUFDVixnQkFBZ0IsQ0FBQztRQUFFL0MsTUFBTTtRQUFFVixVQUFVO1FBQUVZLEtBQUs7UUFBRWpDO01BQVUsQ0FBQyxFQUFFLEVBQUUsRUFBRSxDQUFDLEdBQUcsQ0FBQyxFQUFFMkcsdUJBQWMsQ0FBQztNQUM1RyxPQUFPSCxrQkFBa0IsQ0FBQ2hCLEdBQUcsQ0FBQztJQUNoQyxDQUFDLENBQUMsT0FBTzlCLENBQUMsRUFBRTtNQUNWO01BQ0EsSUFBSUEsQ0FBQyxZQUFZdEksTUFBTSxDQUFDeUwsT0FBTyxFQUFFO1FBQy9CLE1BQU1DLE9BQU8sR0FBR3BELENBQUMsQ0FBQ3FELElBQUk7UUFDdEIsTUFBTUMsU0FBUyxHQUFHdEQsQ0FBQyxDQUFDekUsTUFBTTtRQUMxQixJQUFJNkgsT0FBTyxLQUFLLGNBQWMsSUFBSSxDQUFDRSxTQUFTLEVBQUU7VUFDNUMsT0FBT0wsdUJBQWM7UUFDdkI7TUFDRjtNQUNBO01BQ0E7TUFDQSxJQUFJLEVBQUVqRCxDQUFDLENBQUN1RCxJQUFJLEtBQUssOEJBQThCLENBQUMsRUFBRTtRQUNoRCxNQUFNdkQsQ0FBQztNQUNUO01BQ0E7TUFDQXpFLE1BQU0sR0FBR3lFLENBQUMsQ0FBQ3dELE1BQWdCO01BQzNCLElBQUksQ0FBQ2pJLE1BQU0sRUFBRTtRQUNYLE1BQU15RSxDQUFDO01BQ1Q7SUFDRjtJQUVBLE1BQU04QixHQUFHLEdBQUcsTUFBTSxJQUFJLENBQUNWLGdCQUFnQixDQUFDO01BQUUvQyxNQUFNO01BQUVWLFVBQVU7TUFBRVksS0FBSztNQUFFakM7SUFBVSxDQUFDLEVBQUUsRUFBRSxFQUFFLENBQUMsR0FBRyxDQUFDLEVBQUVmLE1BQU0sQ0FBQztJQUNwRyxPQUFPLE1BQU11SCxrQkFBa0IsQ0FBQ2hCLEdBQUcsQ0FBQztFQUN0Qzs7RUFFQTtBQUNGO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtFQUNFMkIsV0FBV0EsQ0FDVG5HLE9BQXNCLEVBQ3RCK0QsT0FBZSxHQUFHLEVBQUUsRUFDcEJDLGFBQXVCLEdBQUcsQ0FBQyxHQUFHLENBQUMsRUFDL0IvRixNQUFNLEdBQUcsRUFBRSxFQUNYbUksY0FBdUIsRUFDdkJDLEVBQXVELEVBQ3ZEO0lBQ0EsSUFBSUMsSUFBbUM7SUFDdkMsSUFBSUYsY0FBYyxFQUFFO01BQ2xCRSxJQUFJLEdBQUcsSUFBSSxDQUFDeEMsZ0JBQWdCLENBQUM5RCxPQUFPLEVBQUUrRCxPQUFPLEVBQUVDLGFBQWEsRUFBRS9GLE1BQU0sQ0FBQztJQUN2RSxDQUFDLE1BQU07TUFDTDtNQUNBO01BQ0FxSSxJQUFJLEdBQUcsSUFBSSxDQUFDaEMsb0JBQW9CLENBQUN0RSxPQUFPLEVBQUUrRCxPQUFPLEVBQUVDLGFBQWEsRUFBRS9GLE1BQU0sQ0FBQztJQUMzRTtJQUVBcUksSUFBSSxDQUFDQyxJQUFJLENBQ05DLE1BQU0sSUFBS0gsRUFBRSxDQUFDLElBQUksRUFBRUcsTUFBTSxDQUFDLEVBQzNCMUQsR0FBRyxJQUFLO01BQ1A7TUFDQTtNQUNBdUQsRUFBRSxDQUFDdkQsR0FBRyxDQUFDO0lBQ1QsQ0FDRixDQUFDO0VBQ0g7O0VBRUE7QUFDRjtBQUNBO0FBQ0E7QUFDQTtBQUNBO0VBQ0UyRCxpQkFBaUJBLENBQ2Z6RyxPQUFzQixFQUN0QnBHLE1BQWdDLEVBQ2hDdUssU0FBaUIsRUFDakJJLFdBQXFCLEVBQ3JCdEcsTUFBYyxFQUNkbUksY0FBdUIsRUFDdkJDLEVBQXVELEVBQ3ZEO0lBQ0EsTUFBTUssUUFBUSxHQUFHLE1BQUFBLENBQUEsS0FBWTtNQUMzQixNQUFNbEMsR0FBRyxHQUFHLE1BQU0sSUFBSSxDQUFDSCxzQkFBc0IsQ0FBQ3JFLE9BQU8sRUFBRXBHLE1BQU0sRUFBRXVLLFNBQVMsRUFBRUksV0FBVyxFQUFFdEcsTUFBTSxDQUFDO01BQzlGLElBQUksQ0FBQ21JLGNBQWMsRUFBRTtRQUNuQixNQUFNLElBQUEzQix1QkFBYSxFQUFDRCxHQUFHLENBQUM7TUFDMUI7TUFFQSxPQUFPQSxHQUFHO0lBQ1osQ0FBQztJQUVEa0MsUUFBUSxDQUFDLENBQUMsQ0FBQ0gsSUFBSSxDQUNaQyxNQUFNLElBQUtILEVBQUUsQ0FBQyxJQUFJLEVBQUVHLE1BQU0sQ0FBQztJQUM1QjtJQUNBO0lBQ0MxRCxHQUFHLElBQUt1RCxFQUFFLENBQUN2RCxHQUFHLENBQ2pCLENBQUM7RUFDSDs7RUFFQTtBQUNGO0FBQ0E7RUFDRTZELGVBQWVBLENBQUN0RyxVQUFrQixFQUFFZ0csRUFBMEMsRUFBRTtJQUM5RSxPQUFPLElBQUksQ0FBQ3hCLG9CQUFvQixDQUFDeEUsVUFBVSxDQUFDLENBQUNrRyxJQUFJLENBQzlDQyxNQUFNLElBQUtILEVBQUUsQ0FBQyxJQUFJLEVBQUVHLE1BQU0sQ0FBQztJQUM1QjtJQUNBO0lBQ0MxRCxHQUFHLElBQUt1RCxFQUFFLENBQUN2RCxHQUFHLENBQ2pCLENBQUM7RUFDSDs7RUFFQTs7RUFFQTtBQUNGO0FBQ0E7QUFDQTtFQUNFLE1BQU04RCxVQUFVQSxDQUFDdkcsVUFBa0IsRUFBRXBDLE1BQWMsR0FBRyxFQUFFLEVBQUU0SSxRQUF3QixFQUFpQjtJQUNqRyxJQUFJLENBQUMsSUFBQXhCLHlCQUFpQixFQUFDaEYsVUFBVSxDQUFDLEVBQUU7TUFDbEMsTUFBTSxJQUFJakcsTUFBTSxDQUFDa0wsc0JBQXNCLENBQUMsdUJBQXVCLEdBQUdqRixVQUFVLENBQUM7SUFDL0U7SUFDQTtJQUNBLElBQUksSUFBQTVCLGdCQUFRLEVBQUNSLE1BQU0sQ0FBQyxFQUFFO01BQ3BCNEksUUFBUSxHQUFHNUksTUFBTTtNQUNqQkEsTUFBTSxHQUFHLEVBQUU7SUFDYjtJQUVBLElBQUksQ0FBQyxJQUFBQyxnQkFBUSxFQUFDRCxNQUFNLENBQUMsRUFBRTtNQUNyQixNQUFNLElBQUlnQyxTQUFTLENBQUMsbUNBQW1DLENBQUM7SUFDMUQ7SUFDQSxJQUFJNEcsUUFBUSxJQUFJLENBQUMsSUFBQXBJLGdCQUFRLEVBQUNvSSxRQUFRLENBQUMsRUFBRTtNQUNuQyxNQUFNLElBQUk1RyxTQUFTLENBQUMscUNBQXFDLENBQUM7SUFDNUQ7SUFFQSxJQUFJOEQsT0FBTyxHQUFHLEVBQUU7O0lBRWhCO0lBQ0E7SUFDQSxJQUFJOUYsTUFBTSxJQUFJLElBQUksQ0FBQ0EsTUFBTSxFQUFFO01BQ3pCLElBQUlBLE1BQU0sS0FBSyxJQUFJLENBQUNBLE1BQU0sRUFBRTtRQUMxQixNQUFNLElBQUk3RCxNQUFNLENBQUMyRCxvQkFBb0IsQ0FBRSxxQkFBb0IsSUFBSSxDQUFDRSxNQUFPLGVBQWNBLE1BQU8sRUFBQyxDQUFDO01BQ2hHO0lBQ0Y7SUFDQTtJQUNBO0lBQ0EsSUFBSUEsTUFBTSxJQUFJQSxNQUFNLEtBQUswSCx1QkFBYyxFQUFFO01BQ3ZDNUIsT0FBTyxHQUFHeEgsR0FBRyxDQUFDdUssV0FBVyxDQUFDO1FBQ3hCQyx5QkFBeUIsRUFBRTtVQUN6QkMsQ0FBQyxFQUFFO1lBQUVDLEtBQUssRUFBRTtVQUEwQyxDQUFDO1VBQ3ZEQyxrQkFBa0IsRUFBRWpKO1FBQ3RCO01BQ0YsQ0FBQyxDQUFDO0lBQ0o7SUFDQSxNQUFNOEMsTUFBTSxHQUFHLEtBQUs7SUFDcEIsTUFBTUMsT0FBdUIsR0FBRyxDQUFDLENBQUM7SUFFbEMsSUFBSTZGLFFBQVEsSUFBSUEsUUFBUSxDQUFDTSxhQUFhLEVBQUU7TUFDdENuRyxPQUFPLENBQUMsa0NBQWtDLENBQUMsR0FBRyxJQUFJO0lBQ3BEOztJQUVBO0lBQ0EsTUFBTW9HLFdBQVcsR0FBRyxJQUFJLENBQUNuSixNQUFNLElBQUlBLE1BQU0sSUFBSTBILHVCQUFjO0lBRTNELE1BQU0wQixVQUF5QixHQUFHO01BQUV0RyxNQUFNO01BQUVWLFVBQVU7TUFBRVc7SUFBUSxDQUFDO0lBRWpFLElBQUk7TUFDRixNQUFNLElBQUksQ0FBQ3NELG9CQUFvQixDQUFDK0MsVUFBVSxFQUFFdEQsT0FBTyxFQUFFLENBQUMsR0FBRyxDQUFDLEVBQUVxRCxXQUFXLENBQUM7SUFDMUUsQ0FBQyxDQUFDLE9BQU90RSxHQUFZLEVBQUU7TUFDckIsSUFBSTdFLE1BQU0sS0FBSyxFQUFFLElBQUlBLE1BQU0sS0FBSzBILHVCQUFjLEVBQUU7UUFDOUMsSUFBSTdDLEdBQUcsWUFBWTFJLE1BQU0sQ0FBQ3lMLE9BQU8sRUFBRTtVQUNqQyxNQUFNQyxPQUFPLEdBQUdoRCxHQUFHLENBQUNpRCxJQUFJO1VBQ3hCLE1BQU1DLFNBQVMsR0FBR2xELEdBQUcsQ0FBQzdFLE1BQU07VUFDNUIsSUFBSTZILE9BQU8sS0FBSyw4QkFBOEIsSUFBSUUsU0FBUyxLQUFLLEVBQUUsRUFBRTtZQUNsRTtZQUNBLE1BQU0sSUFBSSxDQUFDMUIsb0JBQW9CLENBQUMrQyxVQUFVLEVBQUV0RCxPQUFPLEVBQUUsQ0FBQyxHQUFHLENBQUMsRUFBRStCLE9BQU8sQ0FBQztVQUN0RTtRQUNGO01BQ0Y7TUFDQSxNQUFNaEQsR0FBRztJQUNYO0VBQ0Y7O0VBRUE7QUFDRjtBQUNBO0VBQ0UsTUFBTXdFLFlBQVlBLENBQUNqSCxVQUFrQixFQUFvQjtJQUN2RCxJQUFJLENBQUMsSUFBQWdGLHlCQUFpQixFQUFDaEYsVUFBVSxDQUFDLEVBQUU7TUFDbEMsTUFBTSxJQUFJakcsTUFBTSxDQUFDa0wsc0JBQXNCLENBQUMsdUJBQXVCLEdBQUdqRixVQUFVLENBQUM7SUFDL0U7SUFDQSxNQUFNVSxNQUFNLEdBQUcsTUFBTTtJQUNyQixJQUFJO01BQ0YsTUFBTSxJQUFJLENBQUN1RCxvQkFBb0IsQ0FBQztRQUFFdkQsTUFBTTtRQUFFVjtNQUFXLENBQUMsQ0FBQztJQUN6RCxDQUFDLENBQUMsT0FBT3lDLEdBQUcsRUFBRTtNQUNaO01BQ0EsSUFBSUEsR0FBRyxDQUFDaUQsSUFBSSxLQUFLLGNBQWMsSUFBSWpELEdBQUcsQ0FBQ2lELElBQUksS0FBSyxVQUFVLEVBQUU7UUFDMUQsT0FBTyxLQUFLO01BQ2Q7TUFDQSxNQUFNakQsR0FBRztJQUNYO0lBRUEsT0FBTyxJQUFJO0VBQ2I7O0VBSUE7QUFDRjtBQUNBOztFQUdFLE1BQU15RSxZQUFZQSxDQUFDbEgsVUFBa0IsRUFBaUI7SUFDcEQsSUFBSSxDQUFDLElBQUFnRix5QkFBaUIsRUFBQ2hGLFVBQVUsQ0FBQyxFQUFFO01BQ2xDLE1BQU0sSUFBSWpHLE1BQU0sQ0FBQ2tMLHNCQUFzQixDQUFDLHVCQUF1QixHQUFHakYsVUFBVSxDQUFDO0lBQy9FO0lBQ0EsTUFBTVUsTUFBTSxHQUFHLFFBQVE7SUFDdkIsTUFBTSxJQUFJLENBQUN1RCxvQkFBb0IsQ0FBQztNQUFFdkQsTUFBTTtNQUFFVjtJQUFXLENBQUMsRUFBRSxFQUFFLEVBQUUsQ0FBQyxHQUFHLENBQUMsQ0FBQztJQUNsRSxPQUFPLElBQUksQ0FBQ2YsU0FBUyxDQUFDZSxVQUFVLENBQUM7RUFDbkM7O0VBRUE7QUFDRjtBQUNBO0VBQ0UsTUFBTW1ILFNBQVNBLENBQUNuSCxVQUFrQixFQUFFQyxVQUFrQixFQUFFbUgsT0FBdUIsRUFBNEI7SUFDekcsSUFBSSxDQUFDLElBQUFwQyx5QkFBaUIsRUFBQ2hGLFVBQVUsQ0FBQyxFQUFFO01BQ2xDLE1BQU0sSUFBSWpHLE1BQU0sQ0FBQ2tMLHNCQUFzQixDQUFDLHVCQUF1QixHQUFHakYsVUFBVSxDQUFDO0lBQy9FO0lBQ0EsSUFBSSxDQUFDLElBQUFxSCx5QkFBaUIsRUFBQ3BILFVBQVUsQ0FBQyxFQUFFO01BQ2xDLE1BQU0sSUFBSWxHLE1BQU0sQ0FBQ3VOLHNCQUFzQixDQUFFLHdCQUF1QnJILFVBQVcsRUFBQyxDQUFDO0lBQy9FO0lBQ0EsT0FBTyxJQUFJLENBQUNzSCxnQkFBZ0IsQ0FBQ3ZILFVBQVUsRUFBRUMsVUFBVSxFQUFFLENBQUMsRUFBRSxDQUFDLEVBQUVtSCxPQUFPLENBQUM7RUFDckU7O0VBRUE7QUFDRjtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtFQUNFLE1BQU1HLGdCQUFnQkEsQ0FDcEJ2SCxVQUFrQixFQUNsQkMsVUFBa0IsRUFDbEJ1SCxNQUFjLEVBQ2QzRCxNQUFNLEdBQUcsQ0FBQyxFQUNWdUQsT0FBdUIsRUFDRztJQUMxQixJQUFJLENBQUMsSUFBQXBDLHlCQUFpQixFQUFDaEYsVUFBVSxDQUFDLEVBQUU7TUFDbEMsTUFBTSxJQUFJakcsTUFBTSxDQUFDa0wsc0JBQXNCLENBQUMsdUJBQXVCLEdBQUdqRixVQUFVLENBQUM7SUFDL0U7SUFDQSxJQUFJLENBQUMsSUFBQXFILHlCQUFpQixFQUFDcEgsVUFBVSxDQUFDLEVBQUU7TUFDbEMsTUFBTSxJQUFJbEcsTUFBTSxDQUFDdU4sc0JBQXNCLENBQUUsd0JBQXVCckgsVUFBVyxFQUFDLENBQUM7SUFDL0U7SUFDQSxJQUFJLENBQUMsSUFBQTJELGdCQUFRLEVBQUM0RCxNQUFNLENBQUMsRUFBRTtNQUNyQixNQUFNLElBQUk1SCxTQUFTLENBQUMsbUNBQW1DLENBQUM7SUFDMUQ7SUFDQSxJQUFJLENBQUMsSUFBQWdFLGdCQUFRLEVBQUNDLE1BQU0sQ0FBQyxFQUFFO01BQ3JCLE1BQU0sSUFBSWpFLFNBQVMsQ0FBQyxtQ0FBbUMsQ0FBQztJQUMxRDtJQUVBLElBQUk2SCxLQUFLLEdBQUcsRUFBRTtJQUNkLElBQUlELE1BQU0sSUFBSTNELE1BQU0sRUFBRTtNQUNwQixJQUFJMkQsTUFBTSxFQUFFO1FBQ1ZDLEtBQUssR0FBSSxTQUFRLENBQUNELE1BQU8sR0FBRTtNQUM3QixDQUFDLE1BQU07UUFDTEMsS0FBSyxHQUFHLFVBQVU7UUFDbEJELE1BQU0sR0FBRyxDQUFDO01BQ1o7TUFDQSxJQUFJM0QsTUFBTSxFQUFFO1FBQ1Y0RCxLQUFLLElBQUssR0FBRSxDQUFDNUQsTUFBTSxHQUFHMkQsTUFBTSxHQUFHLENBQUUsRUFBQztNQUNwQztJQUNGO0lBRUEsSUFBSTVHLEtBQUssR0FBRyxFQUFFO0lBQ2QsSUFBSUQsT0FBdUIsR0FBRztNQUM1QixJQUFJOEcsS0FBSyxLQUFLLEVBQUUsSUFBSTtRQUFFQTtNQUFNLENBQUM7SUFDL0IsQ0FBQztJQUVELElBQUlMLE9BQU8sRUFBRTtNQUNYLE1BQU1NLFVBQWtDLEdBQUc7UUFDekMsSUFBSU4sT0FBTyxDQUFDTyxvQkFBb0IsSUFBSTtVQUNsQyxpREFBaUQsRUFBRVAsT0FBTyxDQUFDTztRQUM3RCxDQUFDLENBQUM7UUFDRixJQUFJUCxPQUFPLENBQUNRLGNBQWMsSUFBSTtVQUFFLDJDQUEyQyxFQUFFUixPQUFPLENBQUNRO1FBQWUsQ0FBQyxDQUFDO1FBQ3RHLElBQUlSLE9BQU8sQ0FBQ1MsaUJBQWlCLElBQUk7VUFDL0IsK0NBQStDLEVBQUVULE9BQU8sQ0FBQ1M7UUFDM0QsQ0FBQztNQUNILENBQUM7TUFDRGpILEtBQUssR0FBR2hILEVBQUUsQ0FBQ3lKLFNBQVMsQ0FBQytELE9BQU8sQ0FBQztNQUM3QnpHLE9BQU8sR0FBRztRQUNSLEdBQUcsSUFBQW1ILHVCQUFlLEVBQUNKLFVBQVUsQ0FBQztRQUM5QixHQUFHL0c7TUFDTCxDQUFDO0lBQ0g7SUFFQSxNQUFNb0gsbUJBQW1CLEdBQUcsQ0FBQyxHQUFHLENBQUM7SUFDakMsSUFBSU4sS0FBSyxFQUFFO01BQ1RNLG1CQUFtQixDQUFDQyxJQUFJLENBQUMsR0FBRyxDQUFDO0lBQy9CO0lBQ0EsTUFBTXRILE1BQU0sR0FBRyxLQUFLO0lBRXBCLE9BQU8sTUFBTSxJQUFJLENBQUMrQyxnQkFBZ0IsQ0FBQztNQUFFL0MsTUFBTTtNQUFFVixVQUFVO01BQUVDLFVBQVU7TUFBRVUsT0FBTztNQUFFQztJQUFNLENBQUMsRUFBRSxFQUFFLEVBQUVtSCxtQkFBbUIsQ0FBQztFQUNqSDs7RUFFQTtBQUNGO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7RUFDRSxNQUFNRSxVQUFVQSxDQUFDakksVUFBa0IsRUFBRUMsVUFBa0IsRUFBRWlJLFFBQWdCLEVBQUVkLE9BQXVCLEVBQWlCO0lBQ2pIO0lBQ0EsSUFBSSxDQUFDLElBQUFwQyx5QkFBaUIsRUFBQ2hGLFVBQVUsQ0FBQyxFQUFFO01BQ2xDLE1BQU0sSUFBSWpHLE1BQU0sQ0FBQ2tMLHNCQUFzQixDQUFDLHVCQUF1QixHQUFHakYsVUFBVSxDQUFDO0lBQy9FO0lBQ0EsSUFBSSxDQUFDLElBQUFxSCx5QkFBaUIsRUFBQ3BILFVBQVUsQ0FBQyxFQUFFO01BQ2xDLE1BQU0sSUFBSWxHLE1BQU0sQ0FBQ3VOLHNCQUFzQixDQUFFLHdCQUF1QnJILFVBQVcsRUFBQyxDQUFDO0lBQy9FO0lBQ0EsSUFBSSxDQUFDLElBQUFwQyxnQkFBUSxFQUFDcUssUUFBUSxDQUFDLEVBQUU7TUFDdkIsTUFBTSxJQUFJdEksU0FBUyxDQUFDLHFDQUFxQyxDQUFDO0lBQzVEO0lBRUEsTUFBTXVJLGlCQUFpQixHQUFHLE1BQUFBLENBQUEsS0FBNkI7TUFDckQsSUFBSUMsY0FBK0I7TUFDbkMsTUFBTUMsT0FBTyxHQUFHLE1BQU0sSUFBSSxDQUFDQyxVQUFVLENBQUN0SSxVQUFVLEVBQUVDLFVBQVUsRUFBRW1ILE9BQU8sQ0FBQztNQUN0RSxNQUFNbUIsV0FBVyxHQUFHakUsTUFBTSxDQUFDa0UsSUFBSSxDQUFDSCxPQUFPLENBQUNJLElBQUksQ0FBQyxDQUFDN0csUUFBUSxDQUFDLFFBQVEsQ0FBQztNQUNoRSxNQUFNOEcsUUFBUSxHQUFJLEdBQUVSLFFBQVMsSUFBR0ssV0FBWSxhQUFZO01BRXhELE1BQU1JLFdBQUcsQ0FBQ0MsS0FBSyxDQUFDdFAsSUFBSSxDQUFDdVAsT0FBTyxDQUFDWCxRQUFRLENBQUMsRUFBRTtRQUFFWSxTQUFTLEVBQUU7TUFBSyxDQUFDLENBQUM7TUFFNUQsSUFBSXRCLE1BQU0sR0FBRyxDQUFDO01BQ2QsSUFBSTtRQUNGLE1BQU11QixLQUFLLEdBQUcsTUFBTUosV0FBRyxDQUFDSyxJQUFJLENBQUNOLFFBQVEsQ0FBQztRQUN0QyxJQUFJTCxPQUFPLENBQUNZLElBQUksS0FBS0YsS0FBSyxDQUFDRSxJQUFJLEVBQUU7VUFDL0IsT0FBT1AsUUFBUTtRQUNqQjtRQUNBbEIsTUFBTSxHQUFHdUIsS0FBSyxDQUFDRSxJQUFJO1FBQ25CYixjQUFjLEdBQUdqUCxFQUFFLENBQUMrUCxpQkFBaUIsQ0FBQ1IsUUFBUSxFQUFFO1VBQUVTLEtBQUssRUFBRTtRQUFJLENBQUMsQ0FBQztNQUNqRSxDQUFDLENBQUMsT0FBTzlHLENBQUMsRUFBRTtRQUNWLElBQUlBLENBQUMsWUFBWWxGLEtBQUssSUFBS2tGLENBQUMsQ0FBaUNxRCxJQUFJLEtBQUssUUFBUSxFQUFFO1VBQzlFO1VBQ0EwQyxjQUFjLEdBQUdqUCxFQUFFLENBQUMrUCxpQkFBaUIsQ0FBQ1IsUUFBUSxFQUFFO1lBQUVTLEtBQUssRUFBRTtVQUFJLENBQUMsQ0FBQztRQUNqRSxDQUFDLE1BQU07VUFDTDtVQUNBLE1BQU05RyxDQUFDO1FBQ1Q7TUFDRjtNQUVBLE1BQU0rRyxjQUFjLEdBQUcsTUFBTSxJQUFJLENBQUM3QixnQkFBZ0IsQ0FBQ3ZILFVBQVUsRUFBRUMsVUFBVSxFQUFFdUgsTUFBTSxFQUFFLENBQUMsRUFBRUosT0FBTyxDQUFDO01BRTlGLE1BQU1pQyxxQkFBYSxDQUFDQyxRQUFRLENBQUNGLGNBQWMsRUFBRWhCLGNBQWMsQ0FBQztNQUM1RCxNQUFNVyxLQUFLLEdBQUcsTUFBTUosV0FBRyxDQUFDSyxJQUFJLENBQUNOLFFBQVEsQ0FBQztNQUN0QyxJQUFJSyxLQUFLLENBQUNFLElBQUksS0FBS1osT0FBTyxDQUFDWSxJQUFJLEVBQUU7UUFDL0IsT0FBT1AsUUFBUTtNQUNqQjtNQUVBLE1BQU0sSUFBSXZMLEtBQUssQ0FBQyxzREFBc0QsQ0FBQztJQUN6RSxDQUFDO0lBRUQsTUFBTXVMLFFBQVEsR0FBRyxNQUFNUCxpQkFBaUIsQ0FBQyxDQUFDO0lBQzFDLE1BQU1RLFdBQUcsQ0FBQ1ksTUFBTSxDQUFDYixRQUFRLEVBQUVSLFFBQVEsQ0FBQztFQUN0Qzs7RUFFQTtBQUNGO0FBQ0E7RUFDRSxNQUFNSSxVQUFVQSxDQUFDdEksVUFBa0IsRUFBRUMsVUFBa0IsRUFBRXVKLFFBQXlCLEVBQTJCO0lBQzNHLE1BQU1DLFVBQVUsR0FBR0QsUUFBUSxJQUFJLENBQUMsQ0FBQztJQUNqQyxJQUFJLENBQUMsSUFBQXhFLHlCQUFpQixFQUFDaEYsVUFBVSxDQUFDLEVBQUU7TUFDbEMsTUFBTSxJQUFJakcsTUFBTSxDQUFDa0wsc0JBQXNCLENBQUMsdUJBQXVCLEdBQUdqRixVQUFVLENBQUM7SUFDL0U7SUFDQSxJQUFJLENBQUMsSUFBQXFILHlCQUFpQixFQUFDcEgsVUFBVSxDQUFDLEVBQUU7TUFDbEMsTUFBTSxJQUFJbEcsTUFBTSxDQUFDdU4sc0JBQXNCLENBQUUsd0JBQXVCckgsVUFBVyxFQUFDLENBQUM7SUFDL0U7SUFFQSxJQUFJLENBQUMsSUFBQTdCLGdCQUFRLEVBQUNxTCxVQUFVLENBQUMsRUFBRTtNQUN6QixNQUFNLElBQUkxUCxNQUFNLENBQUMyRCxvQkFBb0IsQ0FBQyxxQ0FBcUMsQ0FBQztJQUM5RTtJQUVBLE1BQU1rRCxLQUFLLEdBQUdoSCxFQUFFLENBQUN5SixTQUFTLENBQUNvRyxVQUFVLENBQUM7SUFDdEMsTUFBTS9JLE1BQU0sR0FBRyxNQUFNO0lBQ3JCLE1BQU15RCxHQUFHLEdBQUcsTUFBTSxJQUFJLENBQUNGLG9CQUFvQixDQUFDO01BQUV2RCxNQUFNO01BQUVWLFVBQVU7TUFBRUMsVUFBVTtNQUFFVztJQUFNLENBQUMsQ0FBQztJQUV0RixPQUFPO01BQ0xxSSxJQUFJLEVBQUVTLFFBQVEsQ0FBQ3ZGLEdBQUcsQ0FBQ3hELE9BQU8sQ0FBQyxnQkFBZ0IsQ0FBVyxDQUFDO01BQ3ZEZ0osUUFBUSxFQUFFLElBQUFDLHVCQUFlLEVBQUN6RixHQUFHLENBQUN4RCxPQUF5QixDQUFDO01BQ3hEa0osWUFBWSxFQUFFLElBQUluRixJQUFJLENBQUNQLEdBQUcsQ0FBQ3hELE9BQU8sQ0FBQyxlQUFlLENBQVcsQ0FBQztNQUM5RG1KLFNBQVMsRUFBRSxJQUFBQyxvQkFBWSxFQUFDNUYsR0FBRyxDQUFDeEQsT0FBeUIsQ0FBQztNQUN0RDhILElBQUksRUFBRSxJQUFBdUIsb0JBQVksRUFBQzdGLEdBQUcsQ0FBQ3hELE9BQU8sQ0FBQzhILElBQUk7SUFDckMsQ0FBQztFQUNIO0VBRUEsTUFBTXdCLFlBQVlBLENBQUNqSyxVQUFrQixFQUFFQyxVQUFrQixFQUFFaUssVUFBMEIsRUFBaUI7SUFDcEcsSUFBSSxDQUFDLElBQUFsRix5QkFBaUIsRUFBQ2hGLFVBQVUsQ0FBQyxFQUFFO01BQ2xDLE1BQU0sSUFBSWpHLE1BQU0sQ0FBQ2tMLHNCQUFzQixDQUFFLHdCQUF1QmpGLFVBQVcsRUFBQyxDQUFDO0lBQy9FO0lBQ0EsSUFBSSxDQUFDLElBQUFxSCx5QkFBaUIsRUFBQ3BILFVBQVUsQ0FBQyxFQUFFO01BQ2xDLE1BQU0sSUFBSWxHLE1BQU0sQ0FBQ3VOLHNCQUFzQixDQUFFLHdCQUF1QnJILFVBQVcsRUFBQyxDQUFDO0lBQy9FO0lBRUEsSUFBSWlLLFVBQVUsSUFBSSxDQUFDLElBQUE5TCxnQkFBUSxFQUFDOEwsVUFBVSxDQUFDLEVBQUU7TUFDdkMsTUFBTSxJQUFJblEsTUFBTSxDQUFDMkQsb0JBQW9CLENBQUMsdUNBQXVDLENBQUM7SUFDaEY7SUFFQSxNQUFNZ0QsTUFBTSxHQUFHLFFBQVE7SUFFdkIsTUFBTUMsT0FBdUIsR0FBRyxDQUFDLENBQUM7SUFDbEMsSUFBSXVKLFVBQVUsYUFBVkEsVUFBVSxlQUFWQSxVQUFVLENBQUVDLGdCQUFnQixFQUFFO01BQ2hDeEosT0FBTyxDQUFDLG1DQUFtQyxDQUFDLEdBQUcsSUFBSTtJQUNyRDtJQUNBLElBQUl1SixVQUFVLGFBQVZBLFVBQVUsZUFBVkEsVUFBVSxDQUFFRSxXQUFXLEVBQUU7TUFDM0J6SixPQUFPLENBQUMsc0JBQXNCLENBQUMsR0FBRyxJQUFJO0lBQ3hDO0lBRUEsTUFBTTBKLFdBQW1DLEdBQUcsQ0FBQyxDQUFDO0lBQzlDLElBQUlILFVBQVUsYUFBVkEsVUFBVSxlQUFWQSxVQUFVLENBQUVKLFNBQVMsRUFBRTtNQUN6Qk8sV0FBVyxDQUFDUCxTQUFTLEdBQUksR0FBRUksVUFBVSxDQUFDSixTQUFVLEVBQUM7SUFDbkQ7SUFDQSxNQUFNbEosS0FBSyxHQUFHaEgsRUFBRSxDQUFDeUosU0FBUyxDQUFDZ0gsV0FBVyxDQUFDO0lBRXZDLE1BQU0sSUFBSSxDQUFDcEcsb0JBQW9CLENBQUM7TUFBRXZELE1BQU07TUFBRVYsVUFBVTtNQUFFQyxVQUFVO01BQUVVLE9BQU87TUFBRUM7SUFBTSxDQUFDLEVBQUUsRUFBRSxFQUFFLENBQUMsR0FBRyxFQUFFLEdBQUcsQ0FBQyxDQUFDO0VBQ3JHOztFQUVBOztFQUVBMEoscUJBQXFCQSxDQUNuQkMsTUFBYyxFQUNkQyxNQUFjLEVBQ2QxQixTQUFrQixFQUMwQjtJQUM1QyxJQUFJMEIsTUFBTSxLQUFLdE4sU0FBUyxFQUFFO01BQ3hCc04sTUFBTSxHQUFHLEVBQUU7SUFDYjtJQUNBLElBQUkxQixTQUFTLEtBQUs1TCxTQUFTLEVBQUU7TUFDM0I0TCxTQUFTLEdBQUcsS0FBSztJQUNuQjtJQUNBLElBQUksQ0FBQyxJQUFBOUQseUJBQWlCLEVBQUN1RixNQUFNLENBQUMsRUFBRTtNQUM5QixNQUFNLElBQUl4USxNQUFNLENBQUNrTCxzQkFBc0IsQ0FBQyx1QkFBdUIsR0FBR3NGLE1BQU0sQ0FBQztJQUMzRTtJQUNBLElBQUksQ0FBQyxJQUFBRSxxQkFBYSxFQUFDRCxNQUFNLENBQUMsRUFBRTtNQUMxQixNQUFNLElBQUl6USxNQUFNLENBQUMyUSxrQkFBa0IsQ0FBRSxvQkFBbUJGLE1BQU8sRUFBQyxDQUFDO0lBQ25FO0lBQ0EsSUFBSSxDQUFDLElBQUE3TSxpQkFBUyxFQUFDbUwsU0FBUyxDQUFDLEVBQUU7TUFDekIsTUFBTSxJQUFJbEosU0FBUyxDQUFDLHVDQUF1QyxDQUFDO0lBQzlEO0lBQ0EsTUFBTStLLFNBQVMsR0FBRzdCLFNBQVMsR0FBRyxFQUFFLEdBQUcsR0FBRztJQUN0QyxJQUFJOEIsU0FBUyxHQUFHLEVBQUU7SUFDbEIsSUFBSUMsY0FBYyxHQUFHLEVBQUU7SUFDdkIsTUFBTUMsT0FBa0IsR0FBRyxFQUFFO0lBQzdCLElBQUlDLEtBQUssR0FBRyxLQUFLOztJQUVqQjtJQUNBLE1BQU1DLFVBQVUsR0FBRyxJQUFJelIsTUFBTSxDQUFDMFIsUUFBUSxDQUFDO01BQUVDLFVBQVUsRUFBRTtJQUFLLENBQUMsQ0FBQztJQUM1REYsVUFBVSxDQUFDRyxLQUFLLEdBQUcsTUFBTTtNQUN2QjtNQUNBLElBQUlMLE9BQU8sQ0FBQ2pILE1BQU0sRUFBRTtRQUNsQixPQUFPbUgsVUFBVSxDQUFDaEQsSUFBSSxDQUFDOEMsT0FBTyxDQUFDTSxLQUFLLENBQUMsQ0FBQyxDQUFDO01BQ3pDO01BQ0EsSUFBSUwsS0FBSyxFQUFFO1FBQ1QsT0FBT0MsVUFBVSxDQUFDaEQsSUFBSSxDQUFDLElBQUksQ0FBQztNQUM5QjtNQUNBLElBQUksQ0FBQ3FELDBCQUEwQixDQUFDZCxNQUFNLEVBQUVDLE1BQU0sRUFBRUksU0FBUyxFQUFFQyxjQUFjLEVBQUVGLFNBQVMsQ0FBQyxDQUFDekUsSUFBSSxDQUN2RkMsTUFBTSxJQUFLO1FBQ1Y7UUFDQTtRQUNBQSxNQUFNLENBQUNtRixRQUFRLENBQUN6SSxPQUFPLENBQUUySCxNQUFNLElBQUtNLE9BQU8sQ0FBQzlDLElBQUksQ0FBQ3dDLE1BQU0sQ0FBQyxDQUFDO1FBQ3pEaFIsS0FBSyxDQUFDK1IsVUFBVSxDQUNkcEYsTUFBTSxDQUFDMkUsT0FBTyxFQUNkLENBQUNVLE1BQU0sRUFBRXhGLEVBQUUsS0FBSztVQUNkO1VBQ0E7VUFDQTtVQUNBLElBQUksQ0FBQ3lGLFNBQVMsQ0FBQ2xCLE1BQU0sRUFBRWlCLE1BQU0sQ0FBQzVQLEdBQUcsRUFBRTRQLE1BQU0sQ0FBQ0UsUUFBUSxDQUFDLENBQUN4RixJQUFJLENBQ3JEeUYsS0FBYSxJQUFLO1lBQ2pCO1lBQ0E7WUFDQUgsTUFBTSxDQUFDdkMsSUFBSSxHQUFHMEMsS0FBSyxDQUFDQyxNQUFNLENBQUMsQ0FBQ0MsR0FBRyxFQUFFQyxJQUFJLEtBQUtELEdBQUcsR0FBR0MsSUFBSSxDQUFDN0MsSUFBSSxFQUFFLENBQUMsQ0FBQztZQUM3RDZCLE9BQU8sQ0FBQzlDLElBQUksQ0FBQ3dELE1BQU0sQ0FBQztZQUNwQnhGLEVBQUUsQ0FBQyxDQUFDO1VBQ04sQ0FBQyxFQUNBdkQsR0FBVSxJQUFLdUQsRUFBRSxDQUFDdkQsR0FBRyxDQUN4QixDQUFDO1FBQ0gsQ0FBQyxFQUNBQSxHQUFHLElBQUs7VUFDUCxJQUFJQSxHQUFHLEVBQUU7WUFDUHVJLFVBQVUsQ0FBQ2UsSUFBSSxDQUFDLE9BQU8sRUFBRXRKLEdBQUcsQ0FBQztZQUM3QjtVQUNGO1VBQ0EsSUFBSTBELE1BQU0sQ0FBQzZGLFdBQVcsRUFBRTtZQUN0QnBCLFNBQVMsR0FBR3pFLE1BQU0sQ0FBQzhGLGFBQWE7WUFDaENwQixjQUFjLEdBQUcxRSxNQUFNLENBQUMrRixrQkFBa0I7VUFDNUMsQ0FBQyxNQUFNO1lBQ0xuQixLQUFLLEdBQUcsSUFBSTtVQUNkOztVQUVBO1VBQ0E7VUFDQUMsVUFBVSxDQUFDRyxLQUFLLENBQUMsQ0FBQztRQUNwQixDQUNGLENBQUM7TUFDSCxDQUFDLEVBQ0E5SSxDQUFDLElBQUs7UUFDTDJJLFVBQVUsQ0FBQ2UsSUFBSSxDQUFDLE9BQU8sRUFBRTFKLENBQUMsQ0FBQztNQUM3QixDQUNGLENBQUM7SUFDSCxDQUFDO0lBQ0QsT0FBTzJJLFVBQVU7RUFDbkI7O0VBRUE7QUFDRjtBQUNBO0VBQ0UsTUFBTUssMEJBQTBCQSxDQUM5QnJMLFVBQWtCLEVBQ2xCd0ssTUFBYyxFQUNkSSxTQUFpQixFQUNqQkMsY0FBc0IsRUFDdEJGLFNBQWlCLEVBQ2E7SUFDOUIsSUFBSSxDQUFDLElBQUEzRix5QkFBaUIsRUFBQ2hGLFVBQVUsQ0FBQyxFQUFFO01BQ2xDLE1BQU0sSUFBSWpHLE1BQU0sQ0FBQ2tMLHNCQUFzQixDQUFDLHVCQUF1QixHQUFHakYsVUFBVSxDQUFDO0lBQy9FO0lBQ0EsSUFBSSxDQUFDLElBQUFuQyxnQkFBUSxFQUFDMk0sTUFBTSxDQUFDLEVBQUU7TUFDckIsTUFBTSxJQUFJNUssU0FBUyxDQUFDLG1DQUFtQyxDQUFDO0lBQzFEO0lBQ0EsSUFBSSxDQUFDLElBQUEvQixnQkFBUSxFQUFDK00sU0FBUyxDQUFDLEVBQUU7TUFDeEIsTUFBTSxJQUFJaEwsU0FBUyxDQUFDLHNDQUFzQyxDQUFDO0lBQzdEO0lBQ0EsSUFBSSxDQUFDLElBQUEvQixnQkFBUSxFQUFDZ04sY0FBYyxDQUFDLEVBQUU7TUFDN0IsTUFBTSxJQUFJakwsU0FBUyxDQUFDLDJDQUEyQyxDQUFDO0lBQ2xFO0lBQ0EsSUFBSSxDQUFDLElBQUEvQixnQkFBUSxFQUFDOE0sU0FBUyxDQUFDLEVBQUU7TUFDeEIsTUFBTSxJQUFJL0ssU0FBUyxDQUFDLHNDQUFzQyxDQUFDO0lBQzdEO0lBQ0EsTUFBTXVNLE9BQU8sR0FBRyxFQUFFO0lBQ2xCQSxPQUFPLENBQUNuRSxJQUFJLENBQUUsVUFBUyxJQUFBb0UsaUJBQVMsRUFBQzVCLE1BQU0sQ0FBRSxFQUFDLENBQUM7SUFDM0MyQixPQUFPLENBQUNuRSxJQUFJLENBQUUsYUFBWSxJQUFBb0UsaUJBQVMsRUFBQ3pCLFNBQVMsQ0FBRSxFQUFDLENBQUM7SUFFakQsSUFBSUMsU0FBUyxFQUFFO01BQ2J1QixPQUFPLENBQUNuRSxJQUFJLENBQUUsY0FBYSxJQUFBb0UsaUJBQVMsRUFBQ3hCLFNBQVMsQ0FBRSxFQUFDLENBQUM7SUFDcEQ7SUFDQSxJQUFJQyxjQUFjLEVBQUU7TUFDbEJzQixPQUFPLENBQUNuRSxJQUFJLENBQUUsb0JBQW1CNkMsY0FBZSxFQUFDLENBQUM7SUFDcEQ7SUFFQSxNQUFNd0IsVUFBVSxHQUFHLElBQUk7SUFDdkJGLE9BQU8sQ0FBQ25FLElBQUksQ0FBRSxlQUFjcUUsVUFBVyxFQUFDLENBQUM7SUFDekNGLE9BQU8sQ0FBQ0csSUFBSSxDQUFDLENBQUM7SUFDZEgsT0FBTyxDQUFDSSxPQUFPLENBQUMsU0FBUyxDQUFDO0lBQzFCLElBQUkzTCxLQUFLLEdBQUcsRUFBRTtJQUNkLElBQUl1TCxPQUFPLENBQUN0SSxNQUFNLEdBQUcsQ0FBQyxFQUFFO01BQ3RCakQsS0FBSyxHQUFJLEdBQUV1TCxPQUFPLENBQUNLLElBQUksQ0FBQyxHQUFHLENBQUUsRUFBQztJQUNoQztJQUNBLE1BQU05TCxNQUFNLEdBQUcsS0FBSztJQUNwQixNQUFNeUQsR0FBRyxHQUFHLE1BQU0sSUFBSSxDQUFDVixnQkFBZ0IsQ0FBQztNQUFFL0MsTUFBTTtNQUFFVixVQUFVO01BQUVZO0lBQU0sQ0FBQyxDQUFDO0lBQ3RFLE1BQU15RCxJQUFJLEdBQUcsTUFBTSxJQUFBZSxzQkFBWSxFQUFDakIsR0FBRyxDQUFDO0lBQ3BDLE9BQU94SixVQUFVLENBQUM4UixrQkFBa0IsQ0FBQ3BJLElBQUksQ0FBQztFQUM1Qzs7RUFFQTtBQUNGO0FBQ0E7QUFDQTtFQUNFLE1BQU1xSSwwQkFBMEJBLENBQUMxTSxVQUFrQixFQUFFQyxVQUFrQixFQUFFVSxPQUF1QixFQUFtQjtJQUNqSCxJQUFJLENBQUMsSUFBQXFFLHlCQUFpQixFQUFDaEYsVUFBVSxDQUFDLEVBQUU7TUFDbEMsTUFBTSxJQUFJakcsTUFBTSxDQUFDa0wsc0JBQXNCLENBQUMsdUJBQXVCLEdBQUdqRixVQUFVLENBQUM7SUFDL0U7SUFDQSxJQUFJLENBQUMsSUFBQXFILHlCQUFpQixFQUFDcEgsVUFBVSxDQUFDLEVBQUU7TUFDbEMsTUFBTSxJQUFJbEcsTUFBTSxDQUFDdU4sc0JBQXNCLENBQUUsd0JBQXVCckgsVUFBVyxFQUFDLENBQUM7SUFDL0U7SUFDQSxJQUFJLENBQUMsSUFBQTdCLGdCQUFRLEVBQUN1QyxPQUFPLENBQUMsRUFBRTtNQUN0QixNQUFNLElBQUk1RyxNQUFNLENBQUN1TixzQkFBc0IsQ0FBQyx3Q0FBd0MsQ0FBQztJQUNuRjtJQUNBLE1BQU01RyxNQUFNLEdBQUcsTUFBTTtJQUNyQixNQUFNRSxLQUFLLEdBQUcsU0FBUztJQUN2QixNQUFNdUQsR0FBRyxHQUFHLE1BQU0sSUFBSSxDQUFDVixnQkFBZ0IsQ0FBQztNQUFFL0MsTUFBTTtNQUFFVixVQUFVO01BQUVDLFVBQVU7TUFBRVcsS0FBSztNQUFFRDtJQUFRLENBQUMsQ0FBQztJQUMzRixNQUFNMEQsSUFBSSxHQUFHLE1BQU0sSUFBQXNJLHNCQUFZLEVBQUN4SSxHQUFHLENBQUM7SUFDcEMsT0FBTyxJQUFBeUksaUNBQXNCLEVBQUN2SSxJQUFJLENBQUN6QyxRQUFRLENBQUMsQ0FBQyxDQUFDO0VBQ2hEOztFQUVBO0FBQ0Y7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0VBQ0UsTUFBTWlMLG9CQUFvQkEsQ0FBQzdNLFVBQWtCLEVBQUVDLFVBQWtCLEVBQUV5TCxRQUFnQixFQUFpQjtJQUNsRyxNQUFNaEwsTUFBTSxHQUFHLFFBQVE7SUFDdkIsTUFBTUUsS0FBSyxHQUFJLFlBQVc4SyxRQUFTLEVBQUM7SUFFcEMsTUFBTW9CLGNBQWMsR0FBRztNQUFFcE0sTUFBTTtNQUFFVixVQUFVO01BQUVDLFVBQVUsRUFBRUEsVUFBVTtNQUFFVztJQUFNLENBQUM7SUFDNUUsTUFBTSxJQUFJLENBQUNxRCxvQkFBb0IsQ0FBQzZJLGNBQWMsRUFBRSxFQUFFLEVBQUUsQ0FBQyxHQUFHLENBQUMsQ0FBQztFQUM1RDtFQUVBLE1BQU1DLFlBQVlBLENBQUMvTSxVQUFrQixFQUFFQyxVQUFrQixFQUErQjtJQUFBLElBQUErTSxhQUFBO0lBQ3RGLElBQUksQ0FBQyxJQUFBaEkseUJBQWlCLEVBQUNoRixVQUFVLENBQUMsRUFBRTtNQUNsQyxNQUFNLElBQUlqRyxNQUFNLENBQUNrTCxzQkFBc0IsQ0FBQyx1QkFBdUIsR0FBR2pGLFVBQVUsQ0FBQztJQUMvRTtJQUNBLElBQUksQ0FBQyxJQUFBcUgseUJBQWlCLEVBQUNwSCxVQUFVLENBQUMsRUFBRTtNQUNsQyxNQUFNLElBQUlsRyxNQUFNLENBQUN1TixzQkFBc0IsQ0FBRSx3QkFBdUJySCxVQUFXLEVBQUMsQ0FBQztJQUMvRTtJQUVBLElBQUlnTixZQUFnRTtJQUNwRSxJQUFJckMsU0FBUyxHQUFHLEVBQUU7SUFDbEIsSUFBSUMsY0FBYyxHQUFHLEVBQUU7SUFDdkIsU0FBUztNQUNQLE1BQU0xRSxNQUFNLEdBQUcsTUFBTSxJQUFJLENBQUNrRiwwQkFBMEIsQ0FBQ3JMLFVBQVUsRUFBRUMsVUFBVSxFQUFFMkssU0FBUyxFQUFFQyxjQUFjLEVBQUUsRUFBRSxDQUFDO01BQzNHLEtBQUssTUFBTVcsTUFBTSxJQUFJckYsTUFBTSxDQUFDMkUsT0FBTyxFQUFFO1FBQ25DLElBQUlVLE1BQU0sQ0FBQzVQLEdBQUcsS0FBS3FFLFVBQVUsRUFBRTtVQUM3QixJQUFJLENBQUNnTixZQUFZLElBQUl6QixNQUFNLENBQUMwQixTQUFTLENBQUNDLE9BQU8sQ0FBQyxDQUFDLEdBQUdGLFlBQVksQ0FBQ0MsU0FBUyxDQUFDQyxPQUFPLENBQUMsQ0FBQyxFQUFFO1lBQ2xGRixZQUFZLEdBQUd6QixNQUFNO1VBQ3ZCO1FBQ0Y7TUFDRjtNQUNBLElBQUlyRixNQUFNLENBQUM2RixXQUFXLEVBQUU7UUFDdEJwQixTQUFTLEdBQUd6RSxNQUFNLENBQUM4RixhQUFhO1FBQ2hDcEIsY0FBYyxHQUFHMUUsTUFBTSxDQUFDK0Ysa0JBQWtCO1FBQzFDO01BQ0Y7TUFFQTtJQUNGO0lBQ0EsUUFBQWMsYUFBQSxHQUFPQyxZQUFZLGNBQUFELGFBQUEsdUJBQVpBLGFBQUEsQ0FBY3RCLFFBQVE7RUFDL0I7O0VBRUE7QUFDRjtBQUNBO0VBQ0UsTUFBTTBCLHVCQUF1QkEsQ0FDM0JwTixVQUFrQixFQUNsQkMsVUFBa0IsRUFDbEJ5TCxRQUFnQixFQUNoQjJCLEtBR0csRUFDa0Q7SUFDckQsSUFBSSxDQUFDLElBQUFySSx5QkFBaUIsRUFBQ2hGLFVBQVUsQ0FBQyxFQUFFO01BQ2xDLE1BQU0sSUFBSWpHLE1BQU0sQ0FBQ2tMLHNCQUFzQixDQUFDLHVCQUF1QixHQUFHakYsVUFBVSxDQUFDO0lBQy9FO0lBQ0EsSUFBSSxDQUFDLElBQUFxSCx5QkFBaUIsRUFBQ3BILFVBQVUsQ0FBQyxFQUFFO01BQ2xDLE1BQU0sSUFBSWxHLE1BQU0sQ0FBQ3VOLHNCQUFzQixDQUFFLHdCQUF1QnJILFVBQVcsRUFBQyxDQUFDO0lBQy9FO0lBQ0EsSUFBSSxDQUFDLElBQUFwQyxnQkFBUSxFQUFDNk4sUUFBUSxDQUFDLEVBQUU7TUFDdkIsTUFBTSxJQUFJOUwsU0FBUyxDQUFDLHFDQUFxQyxDQUFDO0lBQzVEO0lBQ0EsSUFBSSxDQUFDLElBQUF4QixnQkFBUSxFQUFDaVAsS0FBSyxDQUFDLEVBQUU7TUFDcEIsTUFBTSxJQUFJek4sU0FBUyxDQUFDLGlDQUFpQyxDQUFDO0lBQ3hEO0lBRUEsSUFBSSxDQUFDOEwsUUFBUSxFQUFFO01BQ2IsTUFBTSxJQUFJM1IsTUFBTSxDQUFDMkQsb0JBQW9CLENBQUMsMEJBQTBCLENBQUM7SUFDbkU7SUFFQSxNQUFNZ0QsTUFBTSxHQUFHLE1BQU07SUFDckIsTUFBTUUsS0FBSyxHQUFJLFlBQVcsSUFBQXdMLGlCQUFTLEVBQUNWLFFBQVEsQ0FBRSxFQUFDO0lBRS9DLE1BQU00QixPQUFPLEdBQUcsSUFBSW5SLE9BQU0sQ0FBQ0MsT0FBTyxDQUFDLENBQUM7SUFDcEMsTUFBTXNILE9BQU8sR0FBRzRKLE9BQU8sQ0FBQzdHLFdBQVcsQ0FBQztNQUNsQzhHLHVCQUF1QixFQUFFO1FBQ3ZCNUcsQ0FBQyxFQUFFO1VBQ0RDLEtBQUssRUFBRTtRQUNULENBQUM7UUFDRDRHLElBQUksRUFBRUgsS0FBSyxDQUFDSSxHQUFHLENBQUVoRixJQUFJLElBQUs7VUFDeEIsT0FBTztZQUNMaUYsVUFBVSxFQUFFakYsSUFBSSxDQUFDa0YsSUFBSTtZQUNyQkMsSUFBSSxFQUFFbkYsSUFBSSxDQUFDQTtVQUNiLENBQUM7UUFDSCxDQUFDO01BQ0g7SUFDRixDQUFDLENBQUM7SUFFRixNQUFNdEUsR0FBRyxHQUFHLE1BQU0sSUFBSSxDQUFDVixnQkFBZ0IsQ0FBQztNQUFFL0MsTUFBTTtNQUFFVixVQUFVO01BQUVDLFVBQVU7TUFBRVc7SUFBTSxDQUFDLEVBQUU4QyxPQUFPLENBQUM7SUFDM0YsTUFBTVcsSUFBSSxHQUFHLE1BQU0sSUFBQXNJLHNCQUFZLEVBQUN4SSxHQUFHLENBQUM7SUFDcEMsTUFBTWdDLE1BQU0sR0FBRyxJQUFBMEgsaUNBQXNCLEVBQUN4SixJQUFJLENBQUN6QyxRQUFRLENBQUMsQ0FBQyxDQUFDO0lBQ3RELElBQUksQ0FBQ3VFLE1BQU0sRUFBRTtNQUNYLE1BQU0sSUFBSWhKLEtBQUssQ0FBQyxzQ0FBc0MsQ0FBQztJQUN6RDtJQUVBLElBQUlnSixNQUFNLENBQUNWLE9BQU8sRUFBRTtNQUNsQjtNQUNBLE1BQU0sSUFBSTFMLE1BQU0sQ0FBQ3lMLE9BQU8sQ0FBQ1csTUFBTSxDQUFDMkgsVUFBVSxDQUFDO0lBQzdDO0lBRUEsT0FBTztNQUNMO01BQ0E7TUFDQXJGLElBQUksRUFBRXRDLE1BQU0sQ0FBQ3NDLElBQWM7TUFDM0JxQixTQUFTLEVBQUUsSUFBQUMsb0JBQVksRUFBQzVGLEdBQUcsQ0FBQ3hELE9BQXlCO0lBQ3ZELENBQUM7RUFDSDs7RUFFQTtBQUNGO0FBQ0E7RUFDRSxNQUFnQjhLLFNBQVNBLENBQUN6TCxVQUFrQixFQUFFQyxVQUFrQixFQUFFeUwsUUFBZ0IsRUFBMkI7SUFDM0csSUFBSSxDQUFDLElBQUExRyx5QkFBaUIsRUFBQ2hGLFVBQVUsQ0FBQyxFQUFFO01BQ2xDLE1BQU0sSUFBSWpHLE1BQU0sQ0FBQ2tMLHNCQUFzQixDQUFDLHVCQUF1QixHQUFHakYsVUFBVSxDQUFDO0lBQy9FO0lBQ0EsSUFBSSxDQUFDLElBQUFxSCx5QkFBaUIsRUFBQ3BILFVBQVUsQ0FBQyxFQUFFO01BQ2xDLE1BQU0sSUFBSWxHLE1BQU0sQ0FBQ3VOLHNCQUFzQixDQUFFLHdCQUF1QnJILFVBQVcsRUFBQyxDQUFDO0lBQy9FO0lBQ0EsSUFBSSxDQUFDLElBQUFwQyxnQkFBUSxFQUFDNk4sUUFBUSxDQUFDLEVBQUU7TUFDdkIsTUFBTSxJQUFJOUwsU0FBUyxDQUFDLHFDQUFxQyxDQUFDO0lBQzVEO0lBQ0EsSUFBSSxDQUFDOEwsUUFBUSxFQUFFO01BQ2IsTUFBTSxJQUFJM1IsTUFBTSxDQUFDMkQsb0JBQW9CLENBQUMsMEJBQTBCLENBQUM7SUFDbkU7SUFFQSxNQUFNaU8sS0FBcUIsR0FBRyxFQUFFO0lBQ2hDLElBQUlvQyxNQUFNLEdBQUcsQ0FBQztJQUNkLElBQUk1SCxNQUFNO0lBQ1YsR0FBRztNQUNEQSxNQUFNLEdBQUcsTUFBTSxJQUFJLENBQUM2SCxjQUFjLENBQUNoTyxVQUFVLEVBQUVDLFVBQVUsRUFBRXlMLFFBQVEsRUFBRXFDLE1BQU0sQ0FBQztNQUM1RUEsTUFBTSxHQUFHNUgsTUFBTSxDQUFDNEgsTUFBTTtNQUN0QnBDLEtBQUssQ0FBQzNELElBQUksQ0FBQyxHQUFHN0IsTUFBTSxDQUFDd0YsS0FBSyxDQUFDO0lBQzdCLENBQUMsUUFBUXhGLE1BQU0sQ0FBQzZGLFdBQVc7SUFFM0IsT0FBT0wsS0FBSztFQUNkOztFQUVBO0FBQ0Y7QUFDQTtFQUNFLE1BQWNxQyxjQUFjQSxDQUFDaE8sVUFBa0IsRUFBRUMsVUFBa0IsRUFBRXlMLFFBQWdCLEVBQUVxQyxNQUFjLEVBQUU7SUFDckcsSUFBSSxDQUFDLElBQUEvSSx5QkFBaUIsRUFBQ2hGLFVBQVUsQ0FBQyxFQUFFO01BQ2xDLE1BQU0sSUFBSWpHLE1BQU0sQ0FBQ2tMLHNCQUFzQixDQUFDLHVCQUF1QixHQUFHakYsVUFBVSxDQUFDO0lBQy9FO0lBQ0EsSUFBSSxDQUFDLElBQUFxSCx5QkFBaUIsRUFBQ3BILFVBQVUsQ0FBQyxFQUFFO01BQ2xDLE1BQU0sSUFBSWxHLE1BQU0sQ0FBQ3VOLHNCQUFzQixDQUFFLHdCQUF1QnJILFVBQVcsRUFBQyxDQUFDO0lBQy9FO0lBQ0EsSUFBSSxDQUFDLElBQUFwQyxnQkFBUSxFQUFDNk4sUUFBUSxDQUFDLEVBQUU7TUFDdkIsTUFBTSxJQUFJOUwsU0FBUyxDQUFDLHFDQUFxQyxDQUFDO0lBQzVEO0lBQ0EsSUFBSSxDQUFDLElBQUFnRSxnQkFBUSxFQUFDbUssTUFBTSxDQUFDLEVBQUU7TUFDckIsTUFBTSxJQUFJbk8sU0FBUyxDQUFDLG1DQUFtQyxDQUFDO0lBQzFEO0lBQ0EsSUFBSSxDQUFDOEwsUUFBUSxFQUFFO01BQ2IsTUFBTSxJQUFJM1IsTUFBTSxDQUFDMkQsb0JBQW9CLENBQUMsMEJBQTBCLENBQUM7SUFDbkU7SUFFQSxJQUFJa0QsS0FBSyxHQUFJLFlBQVcsSUFBQXdMLGlCQUFTLEVBQUNWLFFBQVEsQ0FBRSxFQUFDO0lBQzdDLElBQUlxQyxNQUFNLEVBQUU7TUFDVm5OLEtBQUssSUFBSyx1QkFBc0JtTixNQUFPLEVBQUM7SUFDMUM7SUFFQSxNQUFNck4sTUFBTSxHQUFHLEtBQUs7SUFDcEIsTUFBTXlELEdBQUcsR0FBRyxNQUFNLElBQUksQ0FBQ1YsZ0JBQWdCLENBQUM7TUFBRS9DLE1BQU07TUFBRVYsVUFBVTtNQUFFQyxVQUFVO01BQUVXO0lBQU0sQ0FBQyxDQUFDO0lBQ2xGLE9BQU9qRyxVQUFVLENBQUNzVCxjQUFjLENBQUMsTUFBTSxJQUFBN0ksc0JBQVksRUFBQ2pCLEdBQUcsQ0FBQyxDQUFDO0VBQzNEO0VBRUEsTUFBTStKLFdBQVdBLENBQUEsRUFBa0M7SUFDakQsTUFBTXhOLE1BQU0sR0FBRyxLQUFLO0lBQ3BCLE1BQU15TixVQUFVLEdBQUcsSUFBSSxDQUFDdlEsTUFBTSxJQUFJMEgsdUJBQWM7SUFDaEQsTUFBTThJLE9BQU8sR0FBRyxNQUFNLElBQUksQ0FBQzNLLGdCQUFnQixDQUFDO01BQUUvQztJQUFPLENBQUMsRUFBRSxFQUFFLEVBQUUsQ0FBQyxHQUFHLENBQUMsRUFBRXlOLFVBQVUsQ0FBQztJQUM5RSxNQUFNRSxTQUFTLEdBQUcsTUFBTSxJQUFBakosc0JBQVksRUFBQ2dKLE9BQU8sQ0FBQztJQUM3QyxPQUFPelQsVUFBVSxDQUFDMlQsZUFBZSxDQUFDRCxTQUFTLENBQUM7RUFDOUM7O0VBRUE7QUFDRjtBQUNBO0VBQ0VFLGlCQUFpQkEsQ0FBQ3RGLElBQVksRUFBRTtJQUM5QixJQUFJLENBQUMsSUFBQXJGLGdCQUFRLEVBQUNxRixJQUFJLENBQUMsRUFBRTtNQUNuQixNQUFNLElBQUlySixTQUFTLENBQUMsaUNBQWlDLENBQUM7SUFDeEQ7SUFDQSxJQUFJcUosSUFBSSxHQUFHLElBQUksQ0FBQ25NLGFBQWEsRUFBRTtNQUM3QixNQUFNLElBQUk4QyxTQUFTLENBQUUsZ0NBQStCLElBQUksQ0FBQzlDLGFBQWMsRUFBQyxDQUFDO0lBQzNFO0lBQ0EsSUFBSSxJQUFJLENBQUNvQyxnQkFBZ0IsRUFBRTtNQUN6QixPQUFPLElBQUksQ0FBQ3RDLFFBQVE7SUFDdEI7SUFDQSxJQUFJQSxRQUFRLEdBQUcsSUFBSSxDQUFDQSxRQUFRO0lBQzVCLFNBQVM7TUFDUDtNQUNBO01BQ0EsSUFBSUEsUUFBUSxHQUFHLEtBQUssR0FBR3FNLElBQUksRUFBRTtRQUMzQixPQUFPck0sUUFBUTtNQUNqQjtNQUNBO01BQ0FBLFFBQVEsSUFBSSxFQUFFLEdBQUcsSUFBSSxHQUFHLElBQUk7SUFDOUI7RUFDRjs7RUFFQTtBQUNGO0FBQ0E7RUFDRSxNQUFNNFIsVUFBVUEsQ0FBQ3hPLFVBQWtCLEVBQUVDLFVBQWtCLEVBQUVpSSxRQUFnQixFQUFFeUIsUUFBeUIsRUFBRTtJQUNwRyxJQUFJLENBQUMsSUFBQTNFLHlCQUFpQixFQUFDaEYsVUFBVSxDQUFDLEVBQUU7TUFDbEMsTUFBTSxJQUFJakcsTUFBTSxDQUFDa0wsc0JBQXNCLENBQUMsdUJBQXVCLEdBQUdqRixVQUFVLENBQUM7SUFDL0U7SUFDQSxJQUFJLENBQUMsSUFBQXFILHlCQUFpQixFQUFDcEgsVUFBVSxDQUFDLEVBQUU7TUFDbEMsTUFBTSxJQUFJbEcsTUFBTSxDQUFDdU4sc0JBQXNCLENBQUUsd0JBQXVCckgsVUFBVyxFQUFDLENBQUM7SUFDL0U7SUFFQSxJQUFJLENBQUMsSUFBQXBDLGdCQUFRLEVBQUNxSyxRQUFRLENBQUMsRUFBRTtNQUN2QixNQUFNLElBQUl0SSxTQUFTLENBQUMscUNBQXFDLENBQUM7SUFDNUQ7SUFDQSxJQUFJK0osUUFBUSxJQUFJLENBQUMsSUFBQXZMLGdCQUFRLEVBQUN1TCxRQUFRLENBQUMsRUFBRTtNQUNuQyxNQUFNLElBQUkvSixTQUFTLENBQUMscUNBQXFDLENBQUM7SUFDNUQ7O0lBRUE7SUFDQStKLFFBQVEsR0FBRyxJQUFBOEUseUJBQWlCLEVBQUM5RSxRQUFRLElBQUksQ0FBQyxDQUFDLEVBQUV6QixRQUFRLENBQUM7SUFDdEQsTUFBTWMsSUFBSSxHQUFHLE1BQU1MLFdBQUcsQ0FBQ0ssSUFBSSxDQUFDZCxRQUFRLENBQUM7SUFDckMsT0FBTyxNQUFNLElBQUksQ0FBQ3dHLFNBQVMsQ0FBQzFPLFVBQVUsRUFBRUMsVUFBVSxFQUFFOUcsRUFBRSxDQUFDd1YsZ0JBQWdCLENBQUN6RyxRQUFRLENBQUMsRUFBRWMsSUFBSSxDQUFDQyxJQUFJLEVBQUVVLFFBQVEsQ0FBQztFQUN6Rzs7RUFFQTtBQUNGO0FBQ0E7QUFDQTtFQUNFLE1BQU0rRSxTQUFTQSxDQUNiMU8sVUFBa0IsRUFDbEJDLFVBQWtCLEVBQ2xCMUcsTUFBeUMsRUFDekMwUCxJQUFhLEVBQ2JVLFFBQTZCLEVBQ0E7SUFDN0IsSUFBSSxDQUFDLElBQUEzRSx5QkFBaUIsRUFBQ2hGLFVBQVUsQ0FBQyxFQUFFO01BQ2xDLE1BQU0sSUFBSWpHLE1BQU0sQ0FBQ2tMLHNCQUFzQixDQUFFLHdCQUF1QmpGLFVBQVcsRUFBQyxDQUFDO0lBQy9FO0lBQ0EsSUFBSSxDQUFDLElBQUFxSCx5QkFBaUIsRUFBQ3BILFVBQVUsQ0FBQyxFQUFFO01BQ2xDLE1BQU0sSUFBSWxHLE1BQU0sQ0FBQ3VOLHNCQUFzQixDQUFFLHdCQUF1QnJILFVBQVcsRUFBQyxDQUFDO0lBQy9FOztJQUVBO0lBQ0E7SUFDQSxJQUFJLElBQUE3QixnQkFBUSxFQUFDNkssSUFBSSxDQUFDLEVBQUU7TUFDbEJVLFFBQVEsR0FBR1YsSUFBSTtJQUNqQjtJQUNBO0lBQ0EsTUFBTXRJLE9BQU8sR0FBRyxJQUFBbUgsdUJBQWUsRUFBQzZCLFFBQVEsQ0FBQztJQUN6QyxJQUFJLE9BQU9wUSxNQUFNLEtBQUssUUFBUSxJQUFJQSxNQUFNLFlBQVkrSyxNQUFNLEVBQUU7TUFDMUQ7TUFDQTJFLElBQUksR0FBRzFQLE1BQU0sQ0FBQ3NLLE1BQU07TUFDcEJ0SyxNQUFNLEdBQUcsSUFBQXFWLHNCQUFjLEVBQUNyVixNQUFNLENBQUM7SUFDakMsQ0FBQyxNQUFNLElBQUksQ0FBQyxJQUFBb0osd0JBQWdCLEVBQUNwSixNQUFNLENBQUMsRUFBRTtNQUNwQyxNQUFNLElBQUlxRyxTQUFTLENBQUMsNEVBQTRFLENBQUM7SUFDbkc7SUFFQSxJQUFJLElBQUFnRSxnQkFBUSxFQUFDcUYsSUFBSSxDQUFDLElBQUlBLElBQUksR0FBRyxDQUFDLEVBQUU7TUFDOUIsTUFBTSxJQUFJbFAsTUFBTSxDQUFDMkQsb0JBQW9CLENBQUUsd0NBQXVDdUwsSUFBSyxFQUFDLENBQUM7SUFDdkY7O0lBRUE7SUFDQTtJQUNBLElBQUksQ0FBQyxJQUFBckYsZ0JBQVEsRUFBQ3FGLElBQUksQ0FBQyxFQUFFO01BQ25CQSxJQUFJLEdBQUcsSUFBSSxDQUFDbk0sYUFBYTtJQUMzQjs7SUFFQTtJQUNBO0lBQ0EsSUFBSW1NLElBQUksS0FBSy9MLFNBQVMsRUFBRTtNQUN0QixNQUFNMlIsUUFBUSxHQUFHLE1BQU0sSUFBQUMsd0JBQWdCLEVBQUN2VixNQUFNLENBQUM7TUFDL0MsSUFBSXNWLFFBQVEsS0FBSyxJQUFJLEVBQUU7UUFDckI1RixJQUFJLEdBQUc0RixRQUFRO01BQ2pCO0lBQ0Y7SUFFQSxJQUFJLENBQUMsSUFBQWpMLGdCQUFRLEVBQUNxRixJQUFJLENBQUMsRUFBRTtNQUNuQjtNQUNBQSxJQUFJLEdBQUcsSUFBSSxDQUFDbk0sYUFBYTtJQUMzQjtJQUNBLElBQUltTSxJQUFJLEtBQUssQ0FBQyxFQUFFO01BQ2QsT0FBTyxJQUFJLENBQUM4RixZQUFZLENBQUMvTyxVQUFVLEVBQUVDLFVBQVUsRUFBRVUsT0FBTyxFQUFFMkQsTUFBTSxDQUFDa0UsSUFBSSxDQUFDLEVBQUUsQ0FBQyxDQUFDO0lBQzVFO0lBRUEsTUFBTTVMLFFBQVEsR0FBRyxJQUFJLENBQUMyUixpQkFBaUIsQ0FBQ3RGLElBQUksQ0FBQztJQUM3QyxJQUFJLE9BQU8xUCxNQUFNLEtBQUssUUFBUSxJQUFJK0ssTUFBTSxDQUFDQyxRQUFRLENBQUNoTCxNQUFNLENBQUMsSUFBSTBQLElBQUksSUFBSXJNLFFBQVEsRUFBRTtNQUM3RSxNQUFNb1MsR0FBRyxHQUFHLElBQUFyTSx3QkFBZ0IsRUFBQ3BKLE1BQU0sQ0FBQyxHQUFHLE1BQU0sSUFBQW9ULHNCQUFZLEVBQUNwVCxNQUFNLENBQUMsR0FBRytLLE1BQU0sQ0FBQ2tFLElBQUksQ0FBQ2pQLE1BQU0sQ0FBQztNQUN2RixPQUFPLElBQUksQ0FBQ3dWLFlBQVksQ0FBQy9PLFVBQVUsRUFBRUMsVUFBVSxFQUFFVSxPQUFPLEVBQUVxTyxHQUFHLENBQUM7SUFDaEU7SUFFQSxPQUFPLElBQUksQ0FBQ0MsWUFBWSxDQUFDalAsVUFBVSxFQUFFQyxVQUFVLEVBQUVVLE9BQU8sRUFBRXBILE1BQU0sRUFBRXFELFFBQVEsQ0FBQztFQUM3RTs7RUFFQTtBQUNGO0FBQ0E7QUFDQTtFQUNFLE1BQWNtUyxZQUFZQSxDQUN4Qi9PLFVBQWtCLEVBQ2xCQyxVQUFrQixFQUNsQlUsT0FBdUIsRUFDdkJxTyxHQUFXLEVBQ2tCO0lBQzdCLE1BQU07TUFBRUUsTUFBTTtNQUFFcEw7SUFBVSxDQUFDLEdBQUcsSUFBQXFMLGtCQUFVLEVBQUNILEdBQUcsRUFBRSxJQUFJLENBQUM3UCxZQUFZLENBQUM7SUFDaEV3QixPQUFPLENBQUMsZ0JBQWdCLENBQUMsR0FBR3FPLEdBQUcsQ0FBQ25MLE1BQU07SUFDdEMsSUFBSSxDQUFDLElBQUksQ0FBQzFFLFlBQVksRUFBRTtNQUN0QndCLE9BQU8sQ0FBQyxhQUFhLENBQUMsR0FBR3VPLE1BQU07SUFDakM7SUFDQSxNQUFNL0ssR0FBRyxHQUFHLE1BQU0sSUFBSSxDQUFDSCxzQkFBc0IsQ0FDM0M7TUFDRXRELE1BQU0sRUFBRSxLQUFLO01BQ2JWLFVBQVU7TUFDVkMsVUFBVTtNQUNWVTtJQUNGLENBQUMsRUFDRHFPLEdBQUcsRUFDSGxMLFNBQVMsRUFDVCxDQUFDLEdBQUcsQ0FBQyxFQUNMLEVBQ0YsQ0FBQztJQUNELE1BQU0sSUFBQU0sdUJBQWEsRUFBQ0QsR0FBRyxDQUFDO0lBQ3hCLE9BQU87TUFDTHNFLElBQUksRUFBRSxJQUFBdUIsb0JBQVksRUFBQzdGLEdBQUcsQ0FBQ3hELE9BQU8sQ0FBQzhILElBQUksQ0FBQztNQUNwQ3FCLFNBQVMsRUFBRSxJQUFBQyxvQkFBWSxFQUFDNUYsR0FBRyxDQUFDeEQsT0FBeUI7SUFDdkQsQ0FBQztFQUNIOztFQUVBO0FBQ0Y7QUFDQTtBQUNBO0VBQ0UsTUFBY3NPLFlBQVlBLENBQ3hCalAsVUFBa0IsRUFDbEJDLFVBQWtCLEVBQ2xCVSxPQUF1QixFQUN2QjBELElBQXFCLEVBQ3JCekgsUUFBZ0IsRUFDYTtJQUM3QjtJQUNBO0lBQ0EsTUFBTXdTLFFBQThCLEdBQUcsQ0FBQyxDQUFDOztJQUV6QztJQUNBO0lBQ0EsTUFBTUMsS0FBYSxHQUFHLEVBQUU7SUFFeEIsTUFBTUMsZ0JBQWdCLEdBQUcsTUFBTSxJQUFJLENBQUN2QyxZQUFZLENBQUMvTSxVQUFVLEVBQUVDLFVBQVUsQ0FBQztJQUN4RSxJQUFJeUwsUUFBZ0I7SUFDcEIsSUFBSSxDQUFDNEQsZ0JBQWdCLEVBQUU7TUFDckI1RCxRQUFRLEdBQUcsTUFBTSxJQUFJLENBQUNnQiwwQkFBMEIsQ0FBQzFNLFVBQVUsRUFBRUMsVUFBVSxFQUFFVSxPQUFPLENBQUM7SUFDbkYsQ0FBQyxNQUFNO01BQ0wrSyxRQUFRLEdBQUc0RCxnQkFBZ0I7TUFDM0IsTUFBTUMsT0FBTyxHQUFHLE1BQU0sSUFBSSxDQUFDOUQsU0FBUyxDQUFDekwsVUFBVSxFQUFFQyxVQUFVLEVBQUVxUCxnQkFBZ0IsQ0FBQztNQUM5RUMsT0FBTyxDQUFDMU0sT0FBTyxDQUFFUixDQUFDLElBQUs7UUFDckIrTSxRQUFRLENBQUMvTSxDQUFDLENBQUNzTCxJQUFJLENBQUMsR0FBR3RMLENBQUM7TUFDdEIsQ0FBQyxDQUFDO0lBQ0o7SUFFQSxNQUFNbU4sUUFBUSxHQUFHLElBQUlDLFlBQVksQ0FBQztNQUFFeEcsSUFBSSxFQUFFck0sUUFBUTtNQUFFOFMsV0FBVyxFQUFFO0lBQU0sQ0FBQyxDQUFDOztJQUV6RTtJQUNBLE1BQU0sQ0FBQzdQLENBQUMsRUFBRThQLENBQUMsQ0FBQyxHQUFHLE1BQU1DLE9BQU8sQ0FBQ0MsR0FBRyxDQUFDLENBQy9CLElBQUlELE9BQU8sQ0FBQyxDQUFDRSxPQUFPLEVBQUVDLE1BQU0sS0FBSztNQUMvQjFMLElBQUksQ0FBQzJMLElBQUksQ0FBQ1IsUUFBUSxDQUFDLENBQUNTLEVBQUUsQ0FBQyxPQUFPLEVBQUVGLE1BQU0sQ0FBQztNQUN2Q1AsUUFBUSxDQUFDUyxFQUFFLENBQUMsS0FBSyxFQUFFSCxPQUFPLENBQUMsQ0FBQ0csRUFBRSxDQUFDLE9BQU8sRUFBRUYsTUFBTSxDQUFDO0lBQ2pELENBQUMsQ0FBQyxFQUNGLENBQUMsWUFBWTtNQUNYLElBQUlHLFVBQVUsR0FBRyxDQUFDO01BRWxCLFdBQVcsTUFBTUMsS0FBSyxJQUFJWCxRQUFRLEVBQUU7UUFDbEMsTUFBTVksR0FBRyxHQUFHcFgsTUFBTSxDQUFDcVgsVUFBVSxDQUFDLEtBQUssQ0FBQyxDQUFDQyxNQUFNLENBQUNILEtBQUssQ0FBQyxDQUFDSSxNQUFNLENBQUMsQ0FBQztRQUUzRCxNQUFNQyxPQUFPLEdBQUdwQixRQUFRLENBQUNjLFVBQVUsQ0FBQztRQUNwQyxJQUFJTSxPQUFPLEVBQUU7VUFDWCxJQUFJQSxPQUFPLENBQUMvSCxJQUFJLEtBQUsySCxHQUFHLENBQUN4TyxRQUFRLENBQUMsS0FBSyxDQUFDLEVBQUU7WUFDeEN5TixLQUFLLENBQUNySCxJQUFJLENBQUM7Y0FBRTJGLElBQUksRUFBRXVDLFVBQVU7Y0FBRXpILElBQUksRUFBRStILE9BQU8sQ0FBQy9IO1lBQUssQ0FBQyxDQUFDO1lBQ3BEeUgsVUFBVSxFQUFFO1lBQ1o7VUFDRjtRQUNGO1FBRUFBLFVBQVUsRUFBRTs7UUFFWjtRQUNBLE1BQU12USxPQUFzQixHQUFHO1VBQzdCZSxNQUFNLEVBQUUsS0FBSztVQUNiRSxLQUFLLEVBQUVoSCxFQUFFLENBQUN5SixTQUFTLENBQUM7WUFBRTZNLFVBQVU7WUFBRXhFO1VBQVMsQ0FBQyxDQUFDO1VBQzdDL0ssT0FBTyxFQUFFO1lBQ1AsZ0JBQWdCLEVBQUV3UCxLQUFLLENBQUN0TSxNQUFNO1lBQzlCLGFBQWEsRUFBRXVNLEdBQUcsQ0FBQ3hPLFFBQVEsQ0FBQyxRQUFRO1VBQ3RDLENBQUM7VUFDRDVCLFVBQVU7VUFDVkM7UUFDRixDQUFDO1FBRUQsTUFBTXVDLFFBQVEsR0FBRyxNQUFNLElBQUksQ0FBQ3lCLG9CQUFvQixDQUFDdEUsT0FBTyxFQUFFd1EsS0FBSyxDQUFDO1FBRWhFLElBQUkxSCxJQUFJLEdBQUdqRyxRQUFRLENBQUM3QixPQUFPLENBQUM4SCxJQUFJO1FBQ2hDLElBQUlBLElBQUksRUFBRTtVQUNSQSxJQUFJLEdBQUdBLElBQUksQ0FBQ3pGLE9BQU8sQ0FBQyxJQUFJLEVBQUUsRUFBRSxDQUFDLENBQUNBLE9BQU8sQ0FBQyxJQUFJLEVBQUUsRUFBRSxDQUFDO1FBQ2pELENBQUMsTUFBTTtVQUNMeUYsSUFBSSxHQUFHLEVBQUU7UUFDWDtRQUVBNEcsS0FBSyxDQUFDckgsSUFBSSxDQUFDO1VBQUUyRixJQUFJLEVBQUV1QyxVQUFVO1VBQUV6SDtRQUFLLENBQUMsQ0FBQztNQUN4QztNQUVBLE9BQU8sTUFBTSxJQUFJLENBQUMyRSx1QkFBdUIsQ0FBQ3BOLFVBQVUsRUFBRUMsVUFBVSxFQUFFeUwsUUFBUSxFQUFFMkQsS0FBSyxDQUFDO0lBQ3BGLENBQUMsRUFBRSxDQUFDLENBQ0wsQ0FBQztJQUVGLE9BQU9NLENBQUM7RUFDVjtFQUlBLE1BQU1jLHVCQUF1QkEsQ0FBQ3pRLFVBQWtCLEVBQWlCO0lBQy9ELElBQUksQ0FBQyxJQUFBZ0YseUJBQWlCLEVBQUNoRixVQUFVLENBQUMsRUFBRTtNQUNsQyxNQUFNLElBQUlqRyxNQUFNLENBQUNrTCxzQkFBc0IsQ0FBQyx1QkFBdUIsR0FBR2pGLFVBQVUsQ0FBQztJQUMvRTtJQUNBLE1BQU1VLE1BQU0sR0FBRyxRQUFRO0lBQ3ZCLE1BQU1FLEtBQUssR0FBRyxhQUFhO0lBQzNCLE1BQU0sSUFBSSxDQUFDcUQsb0JBQW9CLENBQUM7TUFBRXZELE1BQU07TUFBRVYsVUFBVTtNQUFFWTtJQUFNLENBQUMsRUFBRSxFQUFFLEVBQUUsQ0FBQyxHQUFHLEVBQUUsR0FBRyxDQUFDLEVBQUUsRUFBRSxDQUFDO0VBQ3BGO0VBSUEsTUFBTThQLG9CQUFvQkEsQ0FBQzFRLFVBQWtCLEVBQUUyUSxpQkFBd0MsRUFBRTtJQUN2RixJQUFJLENBQUMsSUFBQTNMLHlCQUFpQixFQUFDaEYsVUFBVSxDQUFDLEVBQUU7TUFDbEMsTUFBTSxJQUFJakcsTUFBTSxDQUFDa0wsc0JBQXNCLENBQUMsdUJBQXVCLEdBQUdqRixVQUFVLENBQUM7SUFDL0U7SUFDQSxJQUFJLENBQUMsSUFBQTVCLGdCQUFRLEVBQUN1UyxpQkFBaUIsQ0FBQyxFQUFFO01BQ2hDLE1BQU0sSUFBSTVXLE1BQU0sQ0FBQzJELG9CQUFvQixDQUFDLDhDQUE4QyxDQUFDO0lBQ3ZGLENBQUMsTUFBTTtNQUNMLElBQUltQyxPQUFDLENBQUNLLE9BQU8sQ0FBQ3lRLGlCQUFpQixDQUFDQyxJQUFJLENBQUMsRUFBRTtRQUNyQyxNQUFNLElBQUk3VyxNQUFNLENBQUMyRCxvQkFBb0IsQ0FBQyxzQkFBc0IsQ0FBQztNQUMvRCxDQUFDLE1BQU0sSUFBSWlULGlCQUFpQixDQUFDQyxJQUFJLElBQUksQ0FBQyxJQUFBL1MsZ0JBQVEsRUFBQzhTLGlCQUFpQixDQUFDQyxJQUFJLENBQUMsRUFBRTtRQUN0RSxNQUFNLElBQUk3VyxNQUFNLENBQUMyRCxvQkFBb0IsQ0FBQyx3QkFBd0IsRUFBRWlULGlCQUFpQixDQUFDQyxJQUFJLENBQUM7TUFDekY7TUFDQSxJQUFJL1EsT0FBQyxDQUFDSyxPQUFPLENBQUN5USxpQkFBaUIsQ0FBQ0UsS0FBSyxDQUFDLEVBQUU7UUFDdEMsTUFBTSxJQUFJOVcsTUFBTSxDQUFDMkQsb0JBQW9CLENBQUMsZ0RBQWdELENBQUM7TUFDekY7SUFDRjtJQUNBLE1BQU1nRCxNQUFNLEdBQUcsS0FBSztJQUNwQixNQUFNRSxLQUFLLEdBQUcsYUFBYTtJQUMzQixNQUFNRCxPQUErQixHQUFHLENBQUMsQ0FBQztJQUUxQyxNQUFNbVEsdUJBQXVCLEdBQUc7TUFDOUJDLHdCQUF3QixFQUFFO1FBQ3hCQyxJQUFJLEVBQUVMLGlCQUFpQixDQUFDQyxJQUFJO1FBQzVCSyxJQUFJLEVBQUVOLGlCQUFpQixDQUFDRTtNQUMxQjtJQUNGLENBQUM7SUFFRCxNQUFNdkQsT0FBTyxHQUFHLElBQUluUixPQUFNLENBQUNDLE9BQU8sQ0FBQztNQUFFQyxVQUFVLEVBQUU7UUFBRUMsTUFBTSxFQUFFO01BQU0sQ0FBQztNQUFFQyxRQUFRLEVBQUU7SUFBSyxDQUFDLENBQUM7SUFDckYsTUFBTW1ILE9BQU8sR0FBRzRKLE9BQU8sQ0FBQzdHLFdBQVcsQ0FBQ3FLLHVCQUF1QixDQUFDO0lBQzVEblEsT0FBTyxDQUFDLGFBQWEsQ0FBQyxHQUFHLElBQUF1USxhQUFLLEVBQUN4TixPQUFPLENBQUM7SUFDdkMsTUFBTSxJQUFJLENBQUNPLG9CQUFvQixDQUFDO01BQUV2RCxNQUFNO01BQUVWLFVBQVU7TUFBRVksS0FBSztNQUFFRDtJQUFRLENBQUMsRUFBRStDLE9BQU8sQ0FBQztFQUNsRjtFQUlBLE1BQU15TixvQkFBb0JBLENBQUNuUixVQUFrQixFQUFFO0lBQzdDLElBQUksQ0FBQyxJQUFBZ0YseUJBQWlCLEVBQUNoRixVQUFVLENBQUMsRUFBRTtNQUNsQyxNQUFNLElBQUlqRyxNQUFNLENBQUNrTCxzQkFBc0IsQ0FBQyx1QkFBdUIsR0FBR2pGLFVBQVUsQ0FBQztJQUMvRTtJQUNBLE1BQU1VLE1BQU0sR0FBRyxLQUFLO0lBQ3BCLE1BQU1FLEtBQUssR0FBRyxhQUFhO0lBRTNCLE1BQU13TixPQUFPLEdBQUcsTUFBTSxJQUFJLENBQUMzSyxnQkFBZ0IsQ0FBQztNQUFFL0MsTUFBTTtNQUFFVixVQUFVO01BQUVZO0lBQU0sQ0FBQyxFQUFFLEVBQUUsRUFBRSxDQUFDLEdBQUcsRUFBRSxHQUFHLENBQUMsQ0FBQztJQUMxRixNQUFNeU4sU0FBUyxHQUFHLE1BQU0sSUFBQWpKLHNCQUFZLEVBQUNnSixPQUFPLENBQUM7SUFDN0MsT0FBT3pULFVBQVUsQ0FBQ3lXLHNCQUFzQixDQUFDL0MsU0FBUyxDQUFDO0VBQ3JEO0VBUUEsTUFBTWdELGtCQUFrQkEsQ0FDdEJyUixVQUFrQixFQUNsQkMsVUFBa0IsRUFDbEJtSCxPQUFtQyxFQUNQO0lBQzVCLElBQUksQ0FBQyxJQUFBcEMseUJBQWlCLEVBQUNoRixVQUFVLENBQUMsRUFBRTtNQUNsQyxNQUFNLElBQUlqRyxNQUFNLENBQUNrTCxzQkFBc0IsQ0FBQyx1QkFBdUIsR0FBR2pGLFVBQVUsQ0FBQztJQUMvRTtJQUNBLElBQUksQ0FBQyxJQUFBcUgseUJBQWlCLEVBQUNwSCxVQUFVLENBQUMsRUFBRTtNQUNsQyxNQUFNLElBQUlsRyxNQUFNLENBQUN1TixzQkFBc0IsQ0FBRSx3QkFBdUJySCxVQUFXLEVBQUMsQ0FBQztJQUMvRTtJQUVBLElBQUltSCxPQUFPLEVBQUU7TUFDWCxJQUFJLENBQUMsSUFBQWhKLGdCQUFRLEVBQUNnSixPQUFPLENBQUMsRUFBRTtRQUN0QixNQUFNLElBQUl4SCxTQUFTLENBQUMsb0NBQW9DLENBQUM7TUFDM0QsQ0FBQyxNQUFNLElBQUluRSxNQUFNLENBQUM2VixJQUFJLENBQUNsSyxPQUFPLENBQUMsQ0FBQ3ZELE1BQU0sR0FBRyxDQUFDLElBQUl1RCxPQUFPLENBQUMwQyxTQUFTLElBQUksQ0FBQyxJQUFBak0sZ0JBQVEsRUFBQ3VKLE9BQU8sQ0FBQzBDLFNBQVMsQ0FBQyxFQUFFO1FBQy9GLE1BQU0sSUFBSWxLLFNBQVMsQ0FBQyxzQ0FBc0MsRUFBRXdILE9BQU8sQ0FBQzBDLFNBQVMsQ0FBQztNQUNoRjtJQUNGO0lBRUEsTUFBTXBKLE1BQU0sR0FBRyxLQUFLO0lBQ3BCLElBQUlFLEtBQUssR0FBRyxZQUFZO0lBRXhCLElBQUl3RyxPQUFPLGFBQVBBLE9BQU8sZUFBUEEsT0FBTyxDQUFFMEMsU0FBUyxFQUFFO01BQ3RCbEosS0FBSyxJQUFLLGNBQWF3RyxPQUFPLENBQUMwQyxTQUFVLEVBQUM7SUFDNUM7SUFFQSxNQUFNc0UsT0FBTyxHQUFHLE1BQU0sSUFBSSxDQUFDM0ssZ0JBQWdCLENBQUM7TUFBRS9DLE1BQU07TUFBRVYsVUFBVTtNQUFFQyxVQUFVO01BQUVXO0lBQU0sQ0FBQyxFQUFFLEVBQUUsRUFBRSxDQUFDLEdBQUcsQ0FBQyxDQUFDO0lBQ2pHLE1BQU0yUSxNQUFNLEdBQUcsTUFBTSxJQUFBbk0sc0JBQVksRUFBQ2dKLE9BQU8sQ0FBQztJQUMxQyxPQUFPLElBQUFvRCxxQ0FBMEIsRUFBQ0QsTUFBTSxDQUFDO0VBQzNDO0VBR0EsTUFBTUUsa0JBQWtCQSxDQUN0QnpSLFVBQWtCLEVBQ2xCQyxVQUFrQixFQUNsQnlSLE9BQU8sR0FBRztJQUNSQyxNQUFNLEVBQUVDLDBCQUFpQixDQUFDQztFQUM1QixDQUE4QixFQUNmO0lBQ2YsSUFBSSxDQUFDLElBQUE3TSx5QkFBaUIsRUFBQ2hGLFVBQVUsQ0FBQyxFQUFFO01BQ2xDLE1BQU0sSUFBSWpHLE1BQU0sQ0FBQ2tMLHNCQUFzQixDQUFDLHVCQUF1QixHQUFHakYsVUFBVSxDQUFDO0lBQy9FO0lBQ0EsSUFBSSxDQUFDLElBQUFxSCx5QkFBaUIsRUFBQ3BILFVBQVUsQ0FBQyxFQUFFO01BQ2xDLE1BQU0sSUFBSWxHLE1BQU0sQ0FBQ3VOLHNCQUFzQixDQUFFLHdCQUF1QnJILFVBQVcsRUFBQyxDQUFDO0lBQy9FO0lBRUEsSUFBSSxDQUFDLElBQUE3QixnQkFBUSxFQUFDc1QsT0FBTyxDQUFDLEVBQUU7TUFDdEIsTUFBTSxJQUFJOVIsU0FBUyxDQUFDLG9DQUFvQyxDQUFDO0lBQzNELENBQUMsTUFBTTtNQUNMLElBQUksQ0FBQyxDQUFDZ1MsMEJBQWlCLENBQUNDLE9BQU8sRUFBRUQsMEJBQWlCLENBQUNFLFFBQVEsQ0FBQyxDQUFDM1IsUUFBUSxDQUFDdVIsT0FBTyxhQUFQQSxPQUFPLHVCQUFQQSxPQUFPLENBQUVDLE1BQU0sQ0FBQyxFQUFFO1FBQ3RGLE1BQU0sSUFBSS9SLFNBQVMsQ0FBQyxrQkFBa0IsR0FBRzhSLE9BQU8sQ0FBQ0MsTUFBTSxDQUFDO01BQzFEO01BQ0EsSUFBSUQsT0FBTyxDQUFDNUgsU0FBUyxJQUFJLENBQUM0SCxPQUFPLENBQUM1SCxTQUFTLENBQUNqRyxNQUFNLEVBQUU7UUFDbEQsTUFBTSxJQUFJakUsU0FBUyxDQUFDLHNDQUFzQyxHQUFHOFIsT0FBTyxDQUFDNUgsU0FBUyxDQUFDO01BQ2pGO0lBQ0Y7SUFFQSxNQUFNcEosTUFBTSxHQUFHLEtBQUs7SUFDcEIsSUFBSUUsS0FBSyxHQUFHLFlBQVk7SUFFeEIsSUFBSThRLE9BQU8sQ0FBQzVILFNBQVMsRUFBRTtNQUNyQmxKLEtBQUssSUFBSyxjQUFhOFEsT0FBTyxDQUFDNUgsU0FBVSxFQUFDO0lBQzVDO0lBRUEsTUFBTWlJLE1BQU0sR0FBRztNQUNiQyxNQUFNLEVBQUVOLE9BQU8sQ0FBQ0M7SUFDbEIsQ0FBQztJQUVELE1BQU1yRSxPQUFPLEdBQUcsSUFBSW5SLE9BQU0sQ0FBQ0MsT0FBTyxDQUFDO01BQUU2VixRQUFRLEVBQUUsV0FBVztNQUFFNVYsVUFBVSxFQUFFO1FBQUVDLE1BQU0sRUFBRTtNQUFNLENBQUM7TUFBRUMsUUFBUSxFQUFFO0lBQUssQ0FBQyxDQUFDO0lBQzVHLE1BQU1tSCxPQUFPLEdBQUc0SixPQUFPLENBQUM3RyxXQUFXLENBQUNzTCxNQUFNLENBQUM7SUFDM0MsTUFBTXBSLE9BQStCLEdBQUcsQ0FBQyxDQUFDO0lBQzFDQSxPQUFPLENBQUMsYUFBYSxDQUFDLEdBQUcsSUFBQXVRLGFBQUssRUFBQ3hOLE9BQU8sQ0FBQztJQUV2QyxNQUFNLElBQUksQ0FBQ08sb0JBQW9CLENBQUM7TUFBRXZELE1BQU07TUFBRVYsVUFBVTtNQUFFQyxVQUFVO01BQUVXLEtBQUs7TUFBRUQ7SUFBUSxDQUFDLEVBQUUrQyxPQUFPLENBQUM7RUFDOUY7O0VBRUE7QUFDRjtBQUNBO0VBQ0UsTUFBTXdPLGdCQUFnQkEsQ0FBQ2xTLFVBQWtCLEVBQWtCO0lBQ3pELElBQUksQ0FBQyxJQUFBZ0YseUJBQWlCLEVBQUNoRixVQUFVLENBQUMsRUFBRTtNQUNsQyxNQUFNLElBQUlqRyxNQUFNLENBQUNrTCxzQkFBc0IsQ0FBRSx3QkFBdUJqRixVQUFXLEVBQUMsQ0FBQztJQUMvRTtJQUVBLE1BQU1VLE1BQU0sR0FBRyxLQUFLO0lBQ3BCLE1BQU1FLEtBQUssR0FBRyxTQUFTO0lBQ3ZCLE1BQU1rTSxjQUFjLEdBQUc7TUFBRXBNLE1BQU07TUFBRVYsVUFBVTtNQUFFWTtJQUFNLENBQUM7SUFFcEQsTUFBTTRCLFFBQVEsR0FBRyxNQUFNLElBQUksQ0FBQ2lCLGdCQUFnQixDQUFDcUosY0FBYyxDQUFDO0lBQzVELE1BQU16SSxJQUFJLEdBQUcsTUFBTSxJQUFBZSxzQkFBWSxFQUFDNUMsUUFBUSxDQUFDO0lBQ3pDLE9BQU83SCxVQUFVLENBQUN3WCxZQUFZLENBQUM5TixJQUFJLENBQUM7RUFDdEM7O0VBRUE7QUFDRjtBQUNBO0VBQ0UsTUFBTStOLGdCQUFnQkEsQ0FBQ3BTLFVBQWtCLEVBQUVDLFVBQWtCLEVBQUVtSCxPQUF1QixFQUFrQjtJQUN0RyxNQUFNMUcsTUFBTSxHQUFHLEtBQUs7SUFDcEIsSUFBSUUsS0FBSyxHQUFHLFNBQVM7SUFFckIsSUFBSSxDQUFDLElBQUFvRSx5QkFBaUIsRUFBQ2hGLFVBQVUsQ0FBQyxFQUFFO01BQ2xDLE1BQU0sSUFBSWpHLE1BQU0sQ0FBQ2tMLHNCQUFzQixDQUFDLHVCQUF1QixHQUFHakYsVUFBVSxDQUFDO0lBQy9FO0lBQ0EsSUFBSSxDQUFDLElBQUFxSCx5QkFBaUIsRUFBQ3BILFVBQVUsQ0FBQyxFQUFFO01BQ2xDLE1BQU0sSUFBSWxHLE1BQU0sQ0FBQ2tMLHNCQUFzQixDQUFDLHVCQUF1QixHQUFHaEYsVUFBVSxDQUFDO0lBQy9FO0lBQ0EsSUFBSW1ILE9BQU8sSUFBSSxDQUFDLElBQUFoSixnQkFBUSxFQUFDZ0osT0FBTyxDQUFDLEVBQUU7TUFDakMsTUFBTSxJQUFJck4sTUFBTSxDQUFDMkQsb0JBQW9CLENBQUMsb0NBQW9DLENBQUM7SUFDN0U7SUFFQSxJQUFJMEosT0FBTyxJQUFJQSxPQUFPLENBQUMwQyxTQUFTLEVBQUU7TUFDaENsSixLQUFLLEdBQUksR0FBRUEsS0FBTSxjQUFhd0csT0FBTyxDQUFDMEMsU0FBVSxFQUFDO0lBQ25EO0lBQ0EsTUFBTWdELGNBQTZCLEdBQUc7TUFBRXBNLE1BQU07TUFBRVYsVUFBVTtNQUFFWTtJQUFNLENBQUM7SUFDbkUsSUFBSVgsVUFBVSxFQUFFO01BQ2Q2TSxjQUFjLENBQUMsWUFBWSxDQUFDLEdBQUc3TSxVQUFVO0lBQzNDO0lBRUEsTUFBTXVDLFFBQVEsR0FBRyxNQUFNLElBQUksQ0FBQ2lCLGdCQUFnQixDQUFDcUosY0FBYyxDQUFDO0lBQzVELE1BQU16SSxJQUFJLEdBQUcsTUFBTSxJQUFBZSxzQkFBWSxFQUFDNUMsUUFBUSxDQUFDO0lBQ3pDLE9BQU83SCxVQUFVLENBQUN3WCxZQUFZLENBQUM5TixJQUFJLENBQUM7RUFDdEM7O0VBRUE7QUFDRjtBQUNBO0VBQ0UsTUFBTWdPLGVBQWVBLENBQUNyUyxVQUFrQixFQUFFc1MsTUFBYyxFQUFpQjtJQUN2RTtJQUNBLElBQUksQ0FBQyxJQUFBdE4seUJBQWlCLEVBQUNoRixVQUFVLENBQUMsRUFBRTtNQUNsQyxNQUFNLElBQUlqRyxNQUFNLENBQUNrTCxzQkFBc0IsQ0FBRSx3QkFBdUJqRixVQUFXLEVBQUMsQ0FBQztJQUMvRTtJQUNBLElBQUksQ0FBQyxJQUFBbkMsZ0JBQVEsRUFBQ3lVLE1BQU0sQ0FBQyxFQUFFO01BQ3JCLE1BQU0sSUFBSXZZLE1BQU0sQ0FBQ3dZLHdCQUF3QixDQUFFLDBCQUF5QkQsTUFBTyxxQkFBb0IsQ0FBQztJQUNsRztJQUVBLE1BQU0xUixLQUFLLEdBQUcsUUFBUTtJQUV0QixJQUFJRixNQUFNLEdBQUcsUUFBUTtJQUNyQixJQUFJNFIsTUFBTSxFQUFFO01BQ1Y1UixNQUFNLEdBQUcsS0FBSztJQUNoQjtJQUVBLE1BQU0sSUFBSSxDQUFDdUQsb0JBQW9CLENBQUM7TUFBRXZELE1BQU07TUFBRVYsVUFBVTtNQUFFWTtJQUFNLENBQUMsRUFBRTBSLE1BQU0sRUFBRSxDQUFDLEdBQUcsQ0FBQyxFQUFFLEVBQUUsQ0FBQztFQUNuRjs7RUFFQTtBQUNGO0FBQ0E7RUFDRSxNQUFNRSxlQUFlQSxDQUFDeFMsVUFBa0IsRUFBbUI7SUFDekQ7SUFDQSxJQUFJLENBQUMsSUFBQWdGLHlCQUFpQixFQUFDaEYsVUFBVSxDQUFDLEVBQUU7TUFDbEMsTUFBTSxJQUFJakcsTUFBTSxDQUFDa0wsc0JBQXNCLENBQUUsd0JBQXVCakYsVUFBVyxFQUFDLENBQUM7SUFDL0U7SUFFQSxNQUFNVSxNQUFNLEdBQUcsS0FBSztJQUNwQixNQUFNRSxLQUFLLEdBQUcsUUFBUTtJQUN0QixNQUFNdUQsR0FBRyxHQUFHLE1BQU0sSUFBSSxDQUFDVixnQkFBZ0IsQ0FBQztNQUFFL0MsTUFBTTtNQUFFVixVQUFVO01BQUVZO0lBQU0sQ0FBQyxDQUFDO0lBQ3RFLE9BQU8sTUFBTSxJQUFBd0Usc0JBQVksRUFBQ2pCLEdBQUcsQ0FBQztFQUNoQztFQUVBLE1BQU1zTyxrQkFBa0JBLENBQUN6UyxVQUFrQixFQUFFQyxVQUFrQixFQUFFeVMsYUFBd0IsR0FBRyxDQUFDLENBQUMsRUFBaUI7SUFDN0csSUFBSSxDQUFDLElBQUExTix5QkFBaUIsRUFBQ2hGLFVBQVUsQ0FBQyxFQUFFO01BQ2xDLE1BQU0sSUFBSWpHLE1BQU0sQ0FBQ2tMLHNCQUFzQixDQUFFLHdCQUF1QmpGLFVBQVcsRUFBQyxDQUFDO0lBQy9FO0lBQ0EsSUFBSSxDQUFDLElBQUFxSCx5QkFBaUIsRUFBQ3BILFVBQVUsQ0FBQyxFQUFFO01BQ2xDLE1BQU0sSUFBSWxHLE1BQU0sQ0FBQ3VOLHNCQUFzQixDQUFFLHdCQUF1QnJILFVBQVcsRUFBQyxDQUFDO0lBQy9FO0lBQ0EsSUFBSSxDQUFDLElBQUE3QixnQkFBUSxFQUFDc1UsYUFBYSxDQUFDLEVBQUU7TUFDNUIsTUFBTSxJQUFJM1ksTUFBTSxDQUFDMkQsb0JBQW9CLENBQUMsMENBQTBDLENBQUM7SUFDbkYsQ0FBQyxNQUFNO01BQ0wsSUFBSWdWLGFBQWEsQ0FBQ3ZJLGdCQUFnQixJQUFJLENBQUMsSUFBQXhNLGlCQUFTLEVBQUMrVSxhQUFhLENBQUN2SSxnQkFBZ0IsQ0FBQyxFQUFFO1FBQ2hGLE1BQU0sSUFBSXBRLE1BQU0sQ0FBQzJELG9CQUFvQixDQUFFLHVDQUFzQ2dWLGFBQWEsQ0FBQ3ZJLGdCQUFpQixFQUFDLENBQUM7TUFDaEg7TUFDQSxJQUNFdUksYUFBYSxDQUFDQyxJQUFJLElBQ2xCLENBQUMsQ0FBQ0Msd0JBQWUsQ0FBQ0MsVUFBVSxFQUFFRCx3QkFBZSxDQUFDRSxVQUFVLENBQUMsQ0FBQzNTLFFBQVEsQ0FBQ3VTLGFBQWEsQ0FBQ0MsSUFBSSxDQUFDLEVBQ3RGO1FBQ0EsTUFBTSxJQUFJNVksTUFBTSxDQUFDMkQsb0JBQW9CLENBQUUsa0NBQWlDZ1YsYUFBYSxDQUFDQyxJQUFLLEVBQUMsQ0FBQztNQUMvRjtNQUNBLElBQUlELGFBQWEsQ0FBQ0ssZUFBZSxJQUFJLENBQUMsSUFBQWxWLGdCQUFRLEVBQUM2VSxhQUFhLENBQUNLLGVBQWUsQ0FBQyxFQUFFO1FBQzdFLE1BQU0sSUFBSWhaLE1BQU0sQ0FBQzJELG9CQUFvQixDQUFFLHNDQUFxQ2dWLGFBQWEsQ0FBQ0ssZUFBZ0IsRUFBQyxDQUFDO01BQzlHO01BQ0EsSUFBSUwsYUFBYSxDQUFDNUksU0FBUyxJQUFJLENBQUMsSUFBQWpNLGdCQUFRLEVBQUM2VSxhQUFhLENBQUM1SSxTQUFTLENBQUMsRUFBRTtRQUNqRSxNQUFNLElBQUkvUCxNQUFNLENBQUMyRCxvQkFBb0IsQ0FBRSxnQ0FBK0JnVixhQUFhLENBQUM1SSxTQUFVLEVBQUMsQ0FBQztNQUNsRztJQUNGO0lBRUEsTUFBTXBKLE1BQU0sR0FBRyxLQUFLO0lBQ3BCLElBQUlFLEtBQUssR0FBRyxXQUFXO0lBRXZCLE1BQU1ELE9BQXVCLEdBQUcsQ0FBQyxDQUFDO0lBQ2xDLElBQUkrUixhQUFhLENBQUN2SSxnQkFBZ0IsRUFBRTtNQUNsQ3hKLE9BQU8sQ0FBQyxtQ0FBbUMsQ0FBQyxHQUFHLElBQUk7SUFDckQ7SUFFQSxNQUFNMk0sT0FBTyxHQUFHLElBQUluUixPQUFNLENBQUNDLE9BQU8sQ0FBQztNQUFFNlYsUUFBUSxFQUFFLFdBQVc7TUFBRTVWLFVBQVUsRUFBRTtRQUFFQyxNQUFNLEVBQUU7TUFBTSxDQUFDO01BQUVDLFFBQVEsRUFBRTtJQUFLLENBQUMsQ0FBQztJQUM1RyxNQUFNUyxNQUE4QixHQUFHLENBQUMsQ0FBQztJQUV6QyxJQUFJMFYsYUFBYSxDQUFDQyxJQUFJLEVBQUU7TUFDdEIzVixNQUFNLENBQUNnVyxJQUFJLEdBQUdOLGFBQWEsQ0FBQ0MsSUFBSTtJQUNsQztJQUNBLElBQUlELGFBQWEsQ0FBQ0ssZUFBZSxFQUFFO01BQ2pDL1YsTUFBTSxDQUFDaVcsZUFBZSxHQUFHUCxhQUFhLENBQUNLLGVBQWU7SUFDeEQ7SUFDQSxJQUFJTCxhQUFhLENBQUM1SSxTQUFTLEVBQUU7TUFDM0JsSixLQUFLLElBQUssY0FBYThSLGFBQWEsQ0FBQzVJLFNBQVUsRUFBQztJQUNsRDtJQUVBLE1BQU1wRyxPQUFPLEdBQUc0SixPQUFPLENBQUM3RyxXQUFXLENBQUN6SixNQUFNLENBQUM7SUFFM0MyRCxPQUFPLENBQUMsYUFBYSxDQUFDLEdBQUcsSUFBQXVRLGFBQUssRUFBQ3hOLE9BQU8sQ0FBQztJQUN2QyxNQUFNLElBQUksQ0FBQ08sb0JBQW9CLENBQUM7TUFBRXZELE1BQU07TUFBRVYsVUFBVTtNQUFFQyxVQUFVO01BQUVXLEtBQUs7TUFBRUQ7SUFBUSxDQUFDLEVBQUUrQyxPQUFPLEVBQUUsQ0FBQyxHQUFHLEVBQUUsR0FBRyxDQUFDLENBQUM7RUFDMUc7RUFLQSxNQUFNd1AsbUJBQW1CQSxDQUFDbFQsVUFBa0IsRUFBRTtJQUM1QyxJQUFJLENBQUMsSUFBQWdGLHlCQUFpQixFQUFDaEYsVUFBVSxDQUFDLEVBQUU7TUFDbEMsTUFBTSxJQUFJakcsTUFBTSxDQUFDa0wsc0JBQXNCLENBQUMsdUJBQXVCLEdBQUdqRixVQUFVLENBQUM7SUFDL0U7SUFDQSxNQUFNVSxNQUFNLEdBQUcsS0FBSztJQUNwQixNQUFNRSxLQUFLLEdBQUcsYUFBYTtJQUUzQixNQUFNd04sT0FBTyxHQUFHLE1BQU0sSUFBSSxDQUFDM0ssZ0JBQWdCLENBQUM7TUFBRS9DLE1BQU07TUFBRVYsVUFBVTtNQUFFWTtJQUFNLENBQUMsQ0FBQztJQUMxRSxNQUFNeU4sU0FBUyxHQUFHLE1BQU0sSUFBQWpKLHNCQUFZLEVBQUNnSixPQUFPLENBQUM7SUFDN0MsT0FBT3pULFVBQVUsQ0FBQ3dZLHFCQUFxQixDQUFDOUUsU0FBUyxDQUFDO0VBQ3BEO0VBT0EsTUFBTStFLG1CQUFtQkEsQ0FBQ3BULFVBQWtCLEVBQUVxVCxjQUF5RCxFQUFFO0lBQ3ZHLE1BQU1DLGNBQWMsR0FBRyxDQUFDVix3QkFBZSxDQUFDQyxVQUFVLEVBQUVELHdCQUFlLENBQUNFLFVBQVUsQ0FBQztJQUMvRSxNQUFNUyxVQUFVLEdBQUcsQ0FBQ0MsaUNBQXdCLENBQUNDLElBQUksRUFBRUQsaUNBQXdCLENBQUNFLEtBQUssQ0FBQztJQUVsRixJQUFJLENBQUMsSUFBQTFPLHlCQUFpQixFQUFDaEYsVUFBVSxDQUFDLEVBQUU7TUFDbEMsTUFBTSxJQUFJakcsTUFBTSxDQUFDa0wsc0JBQXNCLENBQUMsdUJBQXVCLEdBQUdqRixVQUFVLENBQUM7SUFDL0U7SUFFQSxJQUFJcVQsY0FBYyxDQUFDVixJQUFJLElBQUksQ0FBQ1csY0FBYyxDQUFDblQsUUFBUSxDQUFDa1QsY0FBYyxDQUFDVixJQUFJLENBQUMsRUFBRTtNQUN4RSxNQUFNLElBQUkvUyxTQUFTLENBQUUsd0NBQXVDMFQsY0FBZSxFQUFDLENBQUM7SUFDL0U7SUFDQSxJQUFJRCxjQUFjLENBQUNNLElBQUksSUFBSSxDQUFDSixVQUFVLENBQUNwVCxRQUFRLENBQUNrVCxjQUFjLENBQUNNLElBQUksQ0FBQyxFQUFFO01BQ3BFLE1BQU0sSUFBSS9ULFNBQVMsQ0FBRSx3Q0FBdUMyVCxVQUFXLEVBQUMsQ0FBQztJQUMzRTtJQUNBLElBQUlGLGNBQWMsQ0FBQ08sUUFBUSxJQUFJLENBQUMsSUFBQWhRLGdCQUFRLEVBQUN5UCxjQUFjLENBQUNPLFFBQVEsQ0FBQyxFQUFFO01BQ2pFLE1BQU0sSUFBSWhVLFNBQVMsQ0FBRSw0Q0FBMkMsQ0FBQztJQUNuRTtJQUVBLE1BQU1jLE1BQU0sR0FBRyxLQUFLO0lBQ3BCLE1BQU1FLEtBQUssR0FBRyxhQUFhO0lBRTNCLE1BQU1tUixNQUE2QixHQUFHO01BQ3BDOEIsaUJBQWlCLEVBQUU7SUFDckIsQ0FBQztJQUNELE1BQU1DLFVBQVUsR0FBR3JZLE1BQU0sQ0FBQzZWLElBQUksQ0FBQytCLGNBQWMsQ0FBQztJQUU5QyxNQUFNVSxZQUFZLEdBQUcsQ0FBQyxNQUFNLEVBQUUsTUFBTSxFQUFFLFVBQVUsQ0FBQyxDQUFDQyxLQUFLLENBQUVDLEdBQUcsSUFBS0gsVUFBVSxDQUFDM1QsUUFBUSxDQUFDOFQsR0FBRyxDQUFDLENBQUM7SUFDMUY7SUFDQSxJQUFJSCxVQUFVLENBQUNqUSxNQUFNLEdBQUcsQ0FBQyxFQUFFO01BQ3pCLElBQUksQ0FBQ2tRLFlBQVksRUFBRTtRQUNqQixNQUFNLElBQUluVSxTQUFTLENBQ2hCLHlHQUNILENBQUM7TUFDSCxDQUFDLE1BQU07UUFDTG1TLE1BQU0sQ0FBQ2QsSUFBSSxHQUFHO1VBQ1ppRCxnQkFBZ0IsRUFBRSxDQUFDO1FBQ3JCLENBQUM7UUFDRCxJQUFJYixjQUFjLENBQUNWLElBQUksRUFBRTtVQUN2QlosTUFBTSxDQUFDZCxJQUFJLENBQUNpRCxnQkFBZ0IsQ0FBQ2xCLElBQUksR0FBR0ssY0FBYyxDQUFDVixJQUFJO1FBQ3pEO1FBQ0EsSUFBSVUsY0FBYyxDQUFDTSxJQUFJLEtBQUtILGlDQUF3QixDQUFDQyxJQUFJLEVBQUU7VUFDekQxQixNQUFNLENBQUNkLElBQUksQ0FBQ2lELGdCQUFnQixDQUFDQyxJQUFJLEdBQUdkLGNBQWMsQ0FBQ08sUUFBUTtRQUM3RCxDQUFDLE1BQU0sSUFBSVAsY0FBYyxDQUFDTSxJQUFJLEtBQUtILGlDQUF3QixDQUFDRSxLQUFLLEVBQUU7VUFDakUzQixNQUFNLENBQUNkLElBQUksQ0FBQ2lELGdCQUFnQixDQUFDRSxLQUFLLEdBQUdmLGNBQWMsQ0FBQ08sUUFBUTtRQUM5RDtNQUNGO0lBQ0Y7SUFFQSxNQUFNdEcsT0FBTyxHQUFHLElBQUluUixPQUFNLENBQUNDLE9BQU8sQ0FBQztNQUNqQzZWLFFBQVEsRUFBRSx5QkFBeUI7TUFDbkM1VixVQUFVLEVBQUU7UUFBRUMsTUFBTSxFQUFFO01BQU0sQ0FBQztNQUM3QkMsUUFBUSxFQUFFO0lBQ1osQ0FBQyxDQUFDO0lBQ0YsTUFBTW1ILE9BQU8sR0FBRzRKLE9BQU8sQ0FBQzdHLFdBQVcsQ0FBQ3NMLE1BQU0sQ0FBQztJQUUzQyxNQUFNcFIsT0FBdUIsR0FBRyxDQUFDLENBQUM7SUFDbENBLE9BQU8sQ0FBQyxhQUFhLENBQUMsR0FBRyxJQUFBdVEsYUFBSyxFQUFDeE4sT0FBTyxDQUFDO0lBRXZDLE1BQU0sSUFBSSxDQUFDTyxvQkFBb0IsQ0FBQztNQUFFdkQsTUFBTTtNQUFFVixVQUFVO01BQUVZLEtBQUs7TUFBRUQ7SUFBUSxDQUFDLEVBQUUrQyxPQUFPLENBQUM7RUFDbEY7RUFFQSxNQUFNMlEsbUJBQW1CQSxDQUFDclUsVUFBa0IsRUFBMEM7SUFDcEYsSUFBSSxDQUFDLElBQUFnRix5QkFBaUIsRUFBQ2hGLFVBQVUsQ0FBQyxFQUFFO01BQ2xDLE1BQU0sSUFBSWpHLE1BQU0sQ0FBQ2tMLHNCQUFzQixDQUFDLHVCQUF1QixHQUFHakYsVUFBVSxDQUFDO0lBQy9FO0lBQ0EsTUFBTVUsTUFBTSxHQUFHLEtBQUs7SUFDcEIsTUFBTUUsS0FBSyxHQUFHLFlBQVk7SUFFMUIsTUFBTXdOLE9BQU8sR0FBRyxNQUFNLElBQUksQ0FBQzNLLGdCQUFnQixDQUFDO01BQUUvQyxNQUFNO01BQUVWLFVBQVU7TUFBRVk7SUFBTSxDQUFDLENBQUM7SUFDMUUsTUFBTXlOLFNBQVMsR0FBRyxNQUFNLElBQUFqSixzQkFBWSxFQUFDZ0osT0FBTyxDQUFDO0lBQzdDLE9BQU8sTUFBTXpULFVBQVUsQ0FBQzJaLDJCQUEyQixDQUFDakcsU0FBUyxDQUFDO0VBQ2hFO0VBRUEsTUFBTWtHLG1CQUFtQkEsQ0FBQ3ZVLFVBQWtCLEVBQUV3VSxhQUE0QyxFQUFpQjtJQUN6RyxJQUFJLENBQUMsSUFBQXhQLHlCQUFpQixFQUFDaEYsVUFBVSxDQUFDLEVBQUU7TUFDbEMsTUFBTSxJQUFJakcsTUFBTSxDQUFDa0wsc0JBQXNCLENBQUMsdUJBQXVCLEdBQUdqRixVQUFVLENBQUM7SUFDL0U7SUFDQSxJQUFJLENBQUN2RSxNQUFNLENBQUM2VixJQUFJLENBQUNrRCxhQUFhLENBQUMsQ0FBQzNRLE1BQU0sRUFBRTtNQUN0QyxNQUFNLElBQUk5SixNQUFNLENBQUMyRCxvQkFBb0IsQ0FBQywwQ0FBMEMsQ0FBQztJQUNuRjtJQUVBLE1BQU1nRCxNQUFNLEdBQUcsS0FBSztJQUNwQixNQUFNRSxLQUFLLEdBQUcsWUFBWTtJQUMxQixNQUFNME0sT0FBTyxHQUFHLElBQUluUixPQUFNLENBQUNDLE9BQU8sQ0FBQztNQUNqQzZWLFFBQVEsRUFBRSx5QkFBeUI7TUFDbkM1VixVQUFVLEVBQUU7UUFBRUMsTUFBTSxFQUFFO01BQU0sQ0FBQztNQUM3QkMsUUFBUSxFQUFFO0lBQ1osQ0FBQyxDQUFDO0lBQ0YsTUFBTW1ILE9BQU8sR0FBRzRKLE9BQU8sQ0FBQzdHLFdBQVcsQ0FBQytOLGFBQWEsQ0FBQztJQUVsRCxNQUFNLElBQUksQ0FBQ3ZRLG9CQUFvQixDQUFDO01BQUV2RCxNQUFNO01BQUVWLFVBQVU7TUFBRVk7SUFBTSxDQUFDLEVBQUU4QyxPQUFPLENBQUM7RUFDekU7RUFFQSxNQUFjK1EsVUFBVUEsQ0FBQ0MsYUFBK0IsRUFBaUI7SUFDdkUsTUFBTTtNQUFFMVUsVUFBVTtNQUFFQyxVQUFVO01BQUUwVSxJQUFJO01BQUVDO0lBQVEsQ0FBQyxHQUFHRixhQUFhO0lBQy9ELE1BQU1oVSxNQUFNLEdBQUcsS0FBSztJQUNwQixJQUFJRSxLQUFLLEdBQUcsU0FBUztJQUVyQixJQUFJZ1UsT0FBTyxJQUFJQSxPQUFPLGFBQVBBLE9BQU8sZUFBUEEsT0FBTyxDQUFFOUssU0FBUyxFQUFFO01BQ2pDbEosS0FBSyxHQUFJLEdBQUVBLEtBQU0sY0FBYWdVLE9BQU8sQ0FBQzlLLFNBQVUsRUFBQztJQUNuRDtJQUNBLE1BQU0rSyxRQUFRLEdBQUcsRUFBRTtJQUNuQixLQUFLLE1BQU0sQ0FBQ2paLEdBQUcsRUFBRWtaLEtBQUssQ0FBQyxJQUFJclosTUFBTSxDQUFDOEYsT0FBTyxDQUFDb1QsSUFBSSxDQUFDLEVBQUU7TUFDL0NFLFFBQVEsQ0FBQzdNLElBQUksQ0FBQztRQUFFK00sR0FBRyxFQUFFblosR0FBRztRQUFFb1osS0FBSyxFQUFFRjtNQUFNLENBQUMsQ0FBQztJQUMzQztJQUNBLE1BQU1HLGFBQWEsR0FBRztNQUNwQkMsT0FBTyxFQUFFO1FBQ1BDLE1BQU0sRUFBRTtVQUNOQyxHQUFHLEVBQUVQO1FBQ1A7TUFDRjtJQUNGLENBQUM7SUFDRCxNQUFNbFUsT0FBTyxHQUFHLENBQUMsQ0FBbUI7SUFDcEMsTUFBTTJNLE9BQU8sR0FBRyxJQUFJblIsT0FBTSxDQUFDQyxPQUFPLENBQUM7TUFBRUcsUUFBUSxFQUFFLElBQUk7TUFBRUYsVUFBVSxFQUFFO1FBQUVDLE1BQU0sRUFBRTtNQUFNO0lBQUUsQ0FBQyxDQUFDO0lBQ3JGLE1BQU0rWSxVQUFVLEdBQUcvUSxNQUFNLENBQUNrRSxJQUFJLENBQUM4RSxPQUFPLENBQUM3RyxXQUFXLENBQUN3TyxhQUFhLENBQUMsQ0FBQztJQUNsRSxNQUFNbkksY0FBYyxHQUFHO01BQ3JCcE0sTUFBTTtNQUNOVixVQUFVO01BQ1ZZLEtBQUs7TUFDTEQsT0FBTztNQUVQLElBQUlWLFVBQVUsSUFBSTtRQUFFQSxVQUFVLEVBQUVBO01BQVcsQ0FBQztJQUM5QyxDQUFDO0lBRURVLE9BQU8sQ0FBQyxhQUFhLENBQUMsR0FBRyxJQUFBdVEsYUFBSyxFQUFDbUUsVUFBVSxDQUFDO0lBRTFDLE1BQU0sSUFBSSxDQUFDcFIsb0JBQW9CLENBQUM2SSxjQUFjLEVBQUV1SSxVQUFVLENBQUM7RUFDN0Q7RUFFQSxNQUFjQyxhQUFhQSxDQUFDO0lBQUV0VixVQUFVO0lBQUVDLFVBQVU7SUFBRWlLO0VBQWdDLENBQUMsRUFBaUI7SUFDdEcsTUFBTXhKLE1BQU0sR0FBRyxRQUFRO0lBQ3ZCLElBQUlFLEtBQUssR0FBRyxTQUFTO0lBRXJCLElBQUlzSixVQUFVLElBQUl6TyxNQUFNLENBQUM2VixJQUFJLENBQUNwSCxVQUFVLENBQUMsQ0FBQ3JHLE1BQU0sSUFBSXFHLFVBQVUsQ0FBQ0osU0FBUyxFQUFFO01BQ3hFbEosS0FBSyxHQUFJLEdBQUVBLEtBQU0sY0FBYXNKLFVBQVUsQ0FBQ0osU0FBVSxFQUFDO0lBQ3REO0lBQ0EsTUFBTWdELGNBQWMsR0FBRztNQUFFcE0sTUFBTTtNQUFFVixVQUFVO01BQUVDLFVBQVU7TUFBRVc7SUFBTSxDQUFDO0lBRWhFLElBQUlYLFVBQVUsRUFBRTtNQUNkNk0sY0FBYyxDQUFDLFlBQVksQ0FBQyxHQUFHN00sVUFBVTtJQUMzQztJQUNBLE1BQU0sSUFBSSxDQUFDd0QsZ0JBQWdCLENBQUNxSixjQUFjLEVBQUUsRUFBRSxFQUFFLENBQUMsR0FBRyxFQUFFLEdBQUcsQ0FBQyxDQUFDO0VBQzdEO0VBRUEsTUFBTXlJLGdCQUFnQkEsQ0FBQ3ZWLFVBQWtCLEVBQUUyVSxJQUFVLEVBQWlCO0lBQ3BFLElBQUksQ0FBQyxJQUFBM1AseUJBQWlCLEVBQUNoRixVQUFVLENBQUMsRUFBRTtNQUNsQyxNQUFNLElBQUlqRyxNQUFNLENBQUNrTCxzQkFBc0IsQ0FBQyx1QkFBdUIsR0FBR2pGLFVBQVUsQ0FBQztJQUMvRTtJQUNBLElBQUksQ0FBQyxJQUFBd1YscUJBQWEsRUFBQ2IsSUFBSSxDQUFDLEVBQUU7TUFDeEIsTUFBTSxJQUFJNWEsTUFBTSxDQUFDMkQsb0JBQW9CLENBQUMsaUNBQWlDLENBQUM7SUFDMUU7SUFDQSxJQUFJakMsTUFBTSxDQUFDNlYsSUFBSSxDQUFDcUQsSUFBSSxDQUFDLENBQUM5USxNQUFNLEdBQUcsRUFBRSxFQUFFO01BQ2pDLE1BQU0sSUFBSTlKLE1BQU0sQ0FBQzJELG9CQUFvQixDQUFDLDZCQUE2QixDQUFDO0lBQ3RFO0lBRUEsTUFBTSxJQUFJLENBQUMrVyxVQUFVLENBQUM7TUFBRXpVLFVBQVU7TUFBRTJVO0lBQUssQ0FBQyxDQUFDO0VBQzdDO0VBRUEsTUFBTWMsbUJBQW1CQSxDQUFDelYsVUFBa0IsRUFBRTtJQUM1QyxJQUFJLENBQUMsSUFBQWdGLHlCQUFpQixFQUFDaEYsVUFBVSxDQUFDLEVBQUU7TUFDbEMsTUFBTSxJQUFJakcsTUFBTSxDQUFDa0wsc0JBQXNCLENBQUMsdUJBQXVCLEdBQUdqRixVQUFVLENBQUM7SUFDL0U7SUFDQSxNQUFNLElBQUksQ0FBQ3NWLGFBQWEsQ0FBQztNQUFFdFY7SUFBVyxDQUFDLENBQUM7RUFDMUM7RUFFQSxNQUFNMFYsZ0JBQWdCQSxDQUFDMVYsVUFBa0IsRUFBRUMsVUFBa0IsRUFBRTBVLElBQVUsRUFBRUMsT0FBcUIsRUFBRTtJQUNoRyxJQUFJLENBQUMsSUFBQTVQLHlCQUFpQixFQUFDaEYsVUFBVSxDQUFDLEVBQUU7TUFDbEMsTUFBTSxJQUFJakcsTUFBTSxDQUFDa0wsc0JBQXNCLENBQUMsdUJBQXVCLEdBQUdqRixVQUFVLENBQUM7SUFDL0U7SUFDQSxJQUFJLENBQUMsSUFBQXFILHlCQUFpQixFQUFDcEgsVUFBVSxDQUFDLEVBQUU7TUFDbEMsTUFBTSxJQUFJbEcsTUFBTSxDQUFDa0wsc0JBQXNCLENBQUMsdUJBQXVCLEdBQUdoRixVQUFVLENBQUM7SUFDL0U7SUFFQSxJQUFJLENBQUMsSUFBQXVWLHFCQUFhLEVBQUNiLElBQUksQ0FBQyxFQUFFO01BQ3hCLE1BQU0sSUFBSTVhLE1BQU0sQ0FBQzJELG9CQUFvQixDQUFDLGlDQUFpQyxDQUFDO0lBQzFFO0lBQ0EsSUFBSWpDLE1BQU0sQ0FBQzZWLElBQUksQ0FBQ3FELElBQUksQ0FBQyxDQUFDOVEsTUFBTSxHQUFHLEVBQUUsRUFBRTtNQUNqQyxNQUFNLElBQUk5SixNQUFNLENBQUMyRCxvQkFBb0IsQ0FBQyw2QkFBNkIsQ0FBQztJQUN0RTtJQUVBLE1BQU0sSUFBSSxDQUFDK1csVUFBVSxDQUFDO01BQUV6VSxVQUFVO01BQUVDLFVBQVU7TUFBRTBVLElBQUk7TUFBRUM7SUFBUSxDQUFDLENBQUM7RUFDbEU7RUFFQSxNQUFNZSxtQkFBbUJBLENBQUMzVixVQUFrQixFQUFFQyxVQUFrQixFQUFFaUssVUFBdUIsRUFBRTtJQUN6RixJQUFJLENBQUMsSUFBQWxGLHlCQUFpQixFQUFDaEYsVUFBVSxDQUFDLEVBQUU7TUFDbEMsTUFBTSxJQUFJakcsTUFBTSxDQUFDa0wsc0JBQXNCLENBQUMsdUJBQXVCLEdBQUdqRixVQUFVLENBQUM7SUFDL0U7SUFDQSxJQUFJLENBQUMsSUFBQXFILHlCQUFpQixFQUFDcEgsVUFBVSxDQUFDLEVBQUU7TUFDbEMsTUFBTSxJQUFJbEcsTUFBTSxDQUFDa0wsc0JBQXNCLENBQUMsdUJBQXVCLEdBQUdoRixVQUFVLENBQUM7SUFDL0U7SUFDQSxJQUFJaUssVUFBVSxJQUFJek8sTUFBTSxDQUFDNlYsSUFBSSxDQUFDcEgsVUFBVSxDQUFDLENBQUNyRyxNQUFNLElBQUksQ0FBQyxJQUFBekYsZ0JBQVEsRUFBQzhMLFVBQVUsQ0FBQyxFQUFFO01BQ3pFLE1BQU0sSUFBSW5RLE1BQU0sQ0FBQzJELG9CQUFvQixDQUFDLHVDQUF1QyxDQUFDO0lBQ2hGO0lBRUEsTUFBTSxJQUFJLENBQUM0WCxhQUFhLENBQUM7TUFBRXRWLFVBQVU7TUFBRUMsVUFBVTtNQUFFaUs7SUFBVyxDQUFDLENBQUM7RUFDbEU7RUFFQSxNQUFNMEwsbUJBQW1CQSxDQUN2QjVWLFVBQWtCLEVBQ2xCQyxVQUFrQixFQUNsQjRWLFVBQXlCLEVBQ1c7SUFDcEMsSUFBSSxDQUFDLElBQUE3USx5QkFBaUIsRUFBQ2hGLFVBQVUsQ0FBQyxFQUFFO01BQ2xDLE1BQU0sSUFBSWpHLE1BQU0sQ0FBQ2tMLHNCQUFzQixDQUFFLHdCQUF1QmpGLFVBQVcsRUFBQyxDQUFDO0lBQy9FO0lBQ0EsSUFBSSxDQUFDLElBQUFxSCx5QkFBaUIsRUFBQ3BILFVBQVUsQ0FBQyxFQUFFO01BQ2xDLE1BQU0sSUFBSWxHLE1BQU0sQ0FBQ3VOLHNCQUFzQixDQUFFLHdCQUF1QnJILFVBQVcsRUFBQyxDQUFDO0lBQy9FO0lBQ0EsSUFBSSxDQUFDSixPQUFDLENBQUNLLE9BQU8sQ0FBQzJWLFVBQVUsQ0FBQyxFQUFFO01BQzFCLElBQUksQ0FBQyxJQUFBaFksZ0JBQVEsRUFBQ2dZLFVBQVUsQ0FBQ0MsVUFBVSxDQUFDLEVBQUU7UUFDcEMsTUFBTSxJQUFJbFcsU0FBUyxDQUFDLDBDQUEwQyxDQUFDO01BQ2pFO01BQ0EsSUFBSSxDQUFDQyxPQUFDLENBQUNLLE9BQU8sQ0FBQzJWLFVBQVUsQ0FBQ0Usa0JBQWtCLENBQUMsRUFBRTtRQUM3QyxJQUFJLENBQUMsSUFBQTNYLGdCQUFRLEVBQUN5WCxVQUFVLENBQUNFLGtCQUFrQixDQUFDLEVBQUU7VUFDNUMsTUFBTSxJQUFJblcsU0FBUyxDQUFDLCtDQUErQyxDQUFDO1FBQ3RFO01BQ0YsQ0FBQyxNQUFNO1FBQ0wsTUFBTSxJQUFJQSxTQUFTLENBQUMsZ0NBQWdDLENBQUM7TUFDdkQ7TUFDQSxJQUFJLENBQUNDLE9BQUMsQ0FBQ0ssT0FBTyxDQUFDMlYsVUFBVSxDQUFDRyxtQkFBbUIsQ0FBQyxFQUFFO1FBQzlDLElBQUksQ0FBQyxJQUFBNVgsZ0JBQVEsRUFBQ3lYLFVBQVUsQ0FBQ0csbUJBQW1CLENBQUMsRUFBRTtVQUM3QyxNQUFNLElBQUlwVyxTQUFTLENBQUMsZ0RBQWdELENBQUM7UUFDdkU7TUFDRixDQUFDLE1BQU07UUFDTCxNQUFNLElBQUlBLFNBQVMsQ0FBQyxpQ0FBaUMsQ0FBQztNQUN4RDtJQUNGLENBQUMsTUFBTTtNQUNMLE1BQU0sSUFBSUEsU0FBUyxDQUFDLHdDQUF3QyxDQUFDO0lBQy9EO0lBRUEsTUFBTWMsTUFBTSxHQUFHLE1BQU07SUFDckIsTUFBTUUsS0FBSyxHQUFJLHNCQUFxQjtJQUVwQyxNQUFNbVIsTUFBaUMsR0FBRyxDQUN4QztNQUNFa0UsVUFBVSxFQUFFSixVQUFVLENBQUNDO0lBQ3pCLENBQUMsRUFDRDtNQUNFSSxjQUFjLEVBQUVMLFVBQVUsQ0FBQ00sY0FBYyxJQUFJO0lBQy9DLENBQUMsRUFDRDtNQUNFQyxrQkFBa0IsRUFBRSxDQUFDUCxVQUFVLENBQUNFLGtCQUFrQjtJQUNwRCxDQUFDLEVBQ0Q7TUFDRU0sbUJBQW1CLEVBQUUsQ0FBQ1IsVUFBVSxDQUFDRyxtQkFBbUI7SUFDdEQsQ0FBQyxDQUNGOztJQUVEO0lBQ0EsSUFBSUgsVUFBVSxDQUFDUyxlQUFlLEVBQUU7TUFDOUJ2RSxNQUFNLENBQUMvSixJQUFJLENBQUM7UUFBRXVPLGVBQWUsRUFBRVYsVUFBVSxhQUFWQSxVQUFVLHVCQUFWQSxVQUFVLENBQUVTO01BQWdCLENBQUMsQ0FBQztJQUMvRDtJQUNBO0lBQ0EsSUFBSVQsVUFBVSxDQUFDVyxTQUFTLEVBQUU7TUFDeEJ6RSxNQUFNLENBQUMvSixJQUFJLENBQUM7UUFBRXlPLFNBQVMsRUFBRVosVUFBVSxDQUFDVztNQUFVLENBQUMsQ0FBQztJQUNsRDtJQUVBLE1BQU1sSixPQUFPLEdBQUcsSUFBSW5SLE9BQU0sQ0FBQ0MsT0FBTyxDQUFDO01BQ2pDNlYsUUFBUSxFQUFFLDRCQUE0QjtNQUN0QzVWLFVBQVUsRUFBRTtRQUFFQyxNQUFNLEVBQUU7TUFBTSxDQUFDO01BQzdCQyxRQUFRLEVBQUU7SUFDWixDQUFDLENBQUM7SUFDRixNQUFNbUgsT0FBTyxHQUFHNEosT0FBTyxDQUFDN0csV0FBVyxDQUFDc0wsTUFBTSxDQUFDO0lBRTNDLE1BQU01TixHQUFHLEdBQUcsTUFBTSxJQUFJLENBQUNWLGdCQUFnQixDQUFDO01BQUUvQyxNQUFNO01BQUVWLFVBQVU7TUFBRUMsVUFBVTtNQUFFVztJQUFNLENBQUMsRUFBRThDLE9BQU8sQ0FBQztJQUMzRixNQUFNVyxJQUFJLEdBQUcsTUFBTSxJQUFBc0ksc0JBQVksRUFBQ3hJLEdBQUcsQ0FBQztJQUNwQyxPQUFPLElBQUF1UywyQ0FBZ0MsRUFBQ3JTLElBQUksQ0FBQztFQUMvQztFQUVBLE1BQWNzUyxvQkFBb0JBLENBQUMzVyxVQUFrQixFQUFFNFcsWUFBa0MsRUFBaUI7SUFDeEcsTUFBTWxXLE1BQU0sR0FBRyxLQUFLO0lBQ3BCLE1BQU1FLEtBQUssR0FBRyxXQUFXO0lBRXpCLE1BQU1ELE9BQXVCLEdBQUcsQ0FBQyxDQUFDO0lBQ2xDLE1BQU0yTSxPQUFPLEdBQUcsSUFBSW5SLE9BQU0sQ0FBQ0MsT0FBTyxDQUFDO01BQ2pDNlYsUUFBUSxFQUFFLHdCQUF3QjtNQUNsQzFWLFFBQVEsRUFBRSxJQUFJO01BQ2RGLFVBQVUsRUFBRTtRQUFFQyxNQUFNLEVBQUU7TUFBTTtJQUM5QixDQUFDLENBQUM7SUFDRixNQUFNb0gsT0FBTyxHQUFHNEosT0FBTyxDQUFDN0csV0FBVyxDQUFDbVEsWUFBWSxDQUFDO0lBQ2pEalcsT0FBTyxDQUFDLGFBQWEsQ0FBQyxHQUFHLElBQUF1USxhQUFLLEVBQUN4TixPQUFPLENBQUM7SUFFdkMsTUFBTSxJQUFJLENBQUNPLG9CQUFvQixDQUFDO01BQUV2RCxNQUFNO01BQUVWLFVBQVU7TUFBRVksS0FBSztNQUFFRDtJQUFRLENBQUMsRUFBRStDLE9BQU8sQ0FBQztFQUNsRjtFQUVBLE1BQU1tVCxxQkFBcUJBLENBQUM3VyxVQUFrQixFQUFpQjtJQUM3RCxJQUFJLENBQUMsSUFBQWdGLHlCQUFpQixFQUFDaEYsVUFBVSxDQUFDLEVBQUU7TUFDbEMsTUFBTSxJQUFJakcsTUFBTSxDQUFDa0wsc0JBQXNCLENBQUMsdUJBQXVCLEdBQUdqRixVQUFVLENBQUM7SUFDL0U7SUFDQSxNQUFNVSxNQUFNLEdBQUcsUUFBUTtJQUN2QixNQUFNRSxLQUFLLEdBQUcsV0FBVztJQUN6QixNQUFNLElBQUksQ0FBQ3FELG9CQUFvQixDQUFDO01BQUV2RCxNQUFNO01BQUVWLFVBQVU7TUFBRVk7SUFBTSxDQUFDLEVBQUUsRUFBRSxFQUFFLENBQUMsR0FBRyxDQUFDLENBQUM7RUFDM0U7RUFFQSxNQUFNa1csa0JBQWtCQSxDQUFDOVcsVUFBa0IsRUFBRStXLGVBQXFDLEVBQWlCO0lBQ2pHLElBQUksQ0FBQyxJQUFBL1IseUJBQWlCLEVBQUNoRixVQUFVLENBQUMsRUFBRTtNQUNsQyxNQUFNLElBQUlqRyxNQUFNLENBQUNrTCxzQkFBc0IsQ0FBQyx1QkFBdUIsR0FBR2pGLFVBQVUsQ0FBQztJQUMvRTtJQUNBLElBQUlILE9BQUMsQ0FBQ0ssT0FBTyxDQUFDNlcsZUFBZSxDQUFDLEVBQUU7TUFDOUIsTUFBTSxJQUFJLENBQUNGLHFCQUFxQixDQUFDN1csVUFBVSxDQUFDO0lBQzlDLENBQUMsTUFBTTtNQUNMLE1BQU0sSUFBSSxDQUFDMlcsb0JBQW9CLENBQUMzVyxVQUFVLEVBQUUrVyxlQUFlLENBQUM7SUFDOUQ7RUFDRjtFQUVBLE1BQU1DLGtCQUFrQkEsQ0FBQ2hYLFVBQWtCLEVBQW1DO0lBQzVFLElBQUksQ0FBQyxJQUFBZ0YseUJBQWlCLEVBQUNoRixVQUFVLENBQUMsRUFBRTtNQUNsQyxNQUFNLElBQUlqRyxNQUFNLENBQUNrTCxzQkFBc0IsQ0FBQyx1QkFBdUIsR0FBR2pGLFVBQVUsQ0FBQztJQUMvRTtJQUNBLE1BQU1VLE1BQU0sR0FBRyxLQUFLO0lBQ3BCLE1BQU1FLEtBQUssR0FBRyxXQUFXO0lBRXpCLE1BQU11RCxHQUFHLEdBQUcsTUFBTSxJQUFJLENBQUNWLGdCQUFnQixDQUFDO01BQUUvQyxNQUFNO01BQUVWLFVBQVU7TUFBRVk7SUFBTSxDQUFDLENBQUM7SUFDdEUsTUFBTXlELElBQUksR0FBRyxNQUFNLElBQUFlLHNCQUFZLEVBQUNqQixHQUFHLENBQUM7SUFDcEMsT0FBT3hKLFVBQVUsQ0FBQ3NjLG9CQUFvQixDQUFDNVMsSUFBSSxDQUFDO0VBQzlDO0VBRUEsTUFBTTZTLG1CQUFtQkEsQ0FBQ2xYLFVBQWtCLEVBQUVtWCxnQkFBbUMsRUFBaUI7SUFDaEcsSUFBSSxDQUFDLElBQUFuUyx5QkFBaUIsRUFBQ2hGLFVBQVUsQ0FBQyxFQUFFO01BQ2xDLE1BQU0sSUFBSWpHLE1BQU0sQ0FBQ2tMLHNCQUFzQixDQUFDLHVCQUF1QixHQUFHakYsVUFBVSxDQUFDO0lBQy9FO0lBQ0EsSUFBSSxDQUFDSCxPQUFDLENBQUNLLE9BQU8sQ0FBQ2lYLGdCQUFnQixDQUFDLElBQUlBLGdCQUFnQixDQUFDbEcsSUFBSSxDQUFDcE4sTUFBTSxHQUFHLENBQUMsRUFBRTtNQUNwRSxNQUFNLElBQUk5SixNQUFNLENBQUMyRCxvQkFBb0IsQ0FBQyxrREFBa0QsR0FBR3laLGdCQUFnQixDQUFDbEcsSUFBSSxDQUFDO0lBQ25IO0lBRUEsSUFBSW1HLGFBQWEsR0FBR0QsZ0JBQWdCO0lBQ3BDLElBQUl0WCxPQUFDLENBQUNLLE9BQU8sQ0FBQ2lYLGdCQUFnQixDQUFDLEVBQUU7TUFDL0JDLGFBQWEsR0FBRztRQUNkO1FBQ0FuRyxJQUFJLEVBQUUsQ0FDSjtVQUNFb0csa0NBQWtDLEVBQUU7WUFDbENDLFlBQVksRUFBRTtVQUNoQjtRQUNGLENBQUM7TUFFTCxDQUFDO0lBQ0g7SUFFQSxNQUFNNVcsTUFBTSxHQUFHLEtBQUs7SUFDcEIsTUFBTUUsS0FBSyxHQUFHLFlBQVk7SUFDMUIsTUFBTTBNLE9BQU8sR0FBRyxJQUFJblIsT0FBTSxDQUFDQyxPQUFPLENBQUM7TUFDakM2VixRQUFRLEVBQUUsbUNBQW1DO01BQzdDNVYsVUFBVSxFQUFFO1FBQUVDLE1BQU0sRUFBRTtNQUFNLENBQUM7TUFDN0JDLFFBQVEsRUFBRTtJQUNaLENBQUMsQ0FBQztJQUNGLE1BQU1tSCxPQUFPLEdBQUc0SixPQUFPLENBQUM3RyxXQUFXLENBQUMyUSxhQUFhLENBQUM7SUFFbEQsTUFBTXpXLE9BQXVCLEdBQUcsQ0FBQyxDQUFDO0lBQ2xDQSxPQUFPLENBQUMsYUFBYSxDQUFDLEdBQUcsSUFBQXVRLGFBQUssRUFBQ3hOLE9BQU8sQ0FBQztJQUV2QyxNQUFNLElBQUksQ0FBQ08sb0JBQW9CLENBQUM7TUFBRXZELE1BQU07TUFBRVYsVUFBVTtNQUFFWSxLQUFLO01BQUVEO0lBQVEsQ0FBQyxFQUFFK0MsT0FBTyxDQUFDO0VBQ2xGO0VBRUEsTUFBTTZULG1CQUFtQkEsQ0FBQ3ZYLFVBQWtCLEVBQUU7SUFDNUMsSUFBSSxDQUFDLElBQUFnRix5QkFBaUIsRUFBQ2hGLFVBQVUsQ0FBQyxFQUFFO01BQ2xDLE1BQU0sSUFBSWpHLE1BQU0sQ0FBQ2tMLHNCQUFzQixDQUFDLHVCQUF1QixHQUFHakYsVUFBVSxDQUFDO0lBQy9FO0lBQ0EsTUFBTVUsTUFBTSxHQUFHLEtBQUs7SUFDcEIsTUFBTUUsS0FBSyxHQUFHLFlBQVk7SUFFMUIsTUFBTXVELEdBQUcsR0FBRyxNQUFNLElBQUksQ0FBQ1YsZ0JBQWdCLENBQUM7TUFBRS9DLE1BQU07TUFBRVYsVUFBVTtNQUFFWTtJQUFNLENBQUMsQ0FBQztJQUN0RSxNQUFNeUQsSUFBSSxHQUFHLE1BQU0sSUFBQWUsc0JBQVksRUFBQ2pCLEdBQUcsQ0FBQztJQUNwQyxPQUFPeEosVUFBVSxDQUFDNmMsMkJBQTJCLENBQUNuVCxJQUFJLENBQUM7RUFDckQ7RUFFQSxNQUFNb1Qsc0JBQXNCQSxDQUFDelgsVUFBa0IsRUFBRTtJQUMvQyxJQUFJLENBQUMsSUFBQWdGLHlCQUFpQixFQUFDaEYsVUFBVSxDQUFDLEVBQUU7TUFDbEMsTUFBTSxJQUFJakcsTUFBTSxDQUFDa0wsc0JBQXNCLENBQUMsdUJBQXVCLEdBQUdqRixVQUFVLENBQUM7SUFDL0U7SUFDQSxNQUFNVSxNQUFNLEdBQUcsUUFBUTtJQUN2QixNQUFNRSxLQUFLLEdBQUcsWUFBWTtJQUUxQixNQUFNLElBQUksQ0FBQ3FELG9CQUFvQixDQUFDO01BQUV2RCxNQUFNO01BQUVWLFVBQVU7TUFBRVk7SUFBTSxDQUFDLEVBQUUsRUFBRSxFQUFFLENBQUMsR0FBRyxDQUFDLENBQUM7RUFDM0U7RUFFQSxNQUFNOFcsa0JBQWtCQSxDQUN0QjFYLFVBQWtCLEVBQ2xCQyxVQUFrQixFQUNsQm1ILE9BQWdDLEVBQ2lCO0lBQ2pELElBQUksQ0FBQyxJQUFBcEMseUJBQWlCLEVBQUNoRixVQUFVLENBQUMsRUFBRTtNQUNsQyxNQUFNLElBQUlqRyxNQUFNLENBQUNrTCxzQkFBc0IsQ0FBQyx1QkFBdUIsR0FBR2pGLFVBQVUsQ0FBQztJQUMvRTtJQUNBLElBQUksQ0FBQyxJQUFBcUgseUJBQWlCLEVBQUNwSCxVQUFVLENBQUMsRUFBRTtNQUNsQyxNQUFNLElBQUlsRyxNQUFNLENBQUN1TixzQkFBc0IsQ0FBRSx3QkFBdUJySCxVQUFXLEVBQUMsQ0FBQztJQUMvRTtJQUNBLElBQUltSCxPQUFPLElBQUksQ0FBQyxJQUFBaEosZ0JBQVEsRUFBQ2dKLE9BQU8sQ0FBQyxFQUFFO01BQ2pDLE1BQU0sSUFBSXJOLE1BQU0sQ0FBQzJELG9CQUFvQixDQUFDLG9DQUFvQyxDQUFDO0lBQzdFLENBQUMsTUFBTSxJQUFJMEosT0FBTyxhQUFQQSxPQUFPLGVBQVBBLE9BQU8sQ0FBRTBDLFNBQVMsSUFBSSxDQUFDLElBQUFqTSxnQkFBUSxFQUFDdUosT0FBTyxDQUFDMEMsU0FBUyxDQUFDLEVBQUU7TUFDN0QsTUFBTSxJQUFJL1AsTUFBTSxDQUFDMkQsb0JBQW9CLENBQUMsc0NBQXNDLENBQUM7SUFDL0U7SUFFQSxNQUFNZ0QsTUFBTSxHQUFHLEtBQUs7SUFDcEIsSUFBSUUsS0FBSyxHQUFHLFdBQVc7SUFDdkIsSUFBSXdHLE9BQU8sYUFBUEEsT0FBTyxlQUFQQSxPQUFPLENBQUUwQyxTQUFTLEVBQUU7TUFDdEJsSixLQUFLLElBQUssY0FBYXdHLE9BQU8sQ0FBQzBDLFNBQVUsRUFBQztJQUM1QztJQUNBLE1BQU0zRixHQUFHLEdBQUcsTUFBTSxJQUFJLENBQUNWLGdCQUFnQixDQUFDO01BQUUvQyxNQUFNO01BQUVWLFVBQVU7TUFBRUMsVUFBVTtNQUFFVztJQUFNLENBQUMsQ0FBQztJQUNsRixNQUFNeUQsSUFBSSxHQUFHLE1BQU0sSUFBQWUsc0JBQVksRUFBQ2pCLEdBQUcsQ0FBQztJQUNwQyxPQUFPeEosVUFBVSxDQUFDZ2QsMEJBQTBCLENBQUN0VCxJQUFJLENBQUM7RUFDcEQ7RUFFQSxNQUFNdVQsYUFBYUEsQ0FBQzVYLFVBQWtCLEVBQUU2WCxXQUErQixFQUFvQztJQUN6RyxJQUFJLENBQUMsSUFBQTdTLHlCQUFpQixFQUFDaEYsVUFBVSxDQUFDLEVBQUU7TUFDbEMsTUFBTSxJQUFJakcsTUFBTSxDQUFDa0wsc0JBQXNCLENBQUMsdUJBQXVCLEdBQUdqRixVQUFVLENBQUM7SUFDL0U7SUFDQSxJQUFJLENBQUM4WCxLQUFLLENBQUNDLE9BQU8sQ0FBQ0YsV0FBVyxDQUFDLEVBQUU7TUFDL0IsTUFBTSxJQUFJOWQsTUFBTSxDQUFDMkQsb0JBQW9CLENBQUMsOEJBQThCLENBQUM7SUFDdkU7SUFFQSxNQUFNc2EsZ0JBQWdCLEdBQUcsTUFBT0MsS0FBeUIsSUFBdUM7TUFDOUYsTUFBTUMsVUFBdUMsR0FBR0QsS0FBSyxDQUFDeEssR0FBRyxDQUFFcUgsS0FBSyxJQUFLO1FBQ25FLE9BQU8sSUFBQTFXLGdCQUFRLEVBQUMwVyxLQUFLLENBQUMsR0FBRztVQUFFQyxHQUFHLEVBQUVELEtBQUssQ0FBQ2xQLElBQUk7VUFBRXVTLFNBQVMsRUFBRXJELEtBQUssQ0FBQ2hMO1FBQVUsQ0FBQyxHQUFHO1VBQUVpTCxHQUFHLEVBQUVEO1FBQU0sQ0FBQztNQUMzRixDQUFDLENBQUM7TUFFRixNQUFNc0QsVUFBVSxHQUFHO1FBQUVDLE1BQU0sRUFBRTtVQUFFQyxLQUFLLEVBQUUsSUFBSTtVQUFFN2MsTUFBTSxFQUFFeWM7UUFBVztNQUFFLENBQUM7TUFDbEUsTUFBTXhVLE9BQU8sR0FBR1ksTUFBTSxDQUFDa0UsSUFBSSxDQUFDLElBQUlyTSxPQUFNLENBQUNDLE9BQU8sQ0FBQztRQUFFRyxRQUFRLEVBQUU7TUFBSyxDQUFDLENBQUMsQ0FBQ2tLLFdBQVcsQ0FBQzJSLFVBQVUsQ0FBQyxDQUFDO01BQzNGLE1BQU16WCxPQUF1QixHQUFHO1FBQUUsYUFBYSxFQUFFLElBQUF1USxhQUFLLEVBQUN4TixPQUFPO01BQUUsQ0FBQztNQUVqRSxNQUFNUyxHQUFHLEdBQUcsTUFBTSxJQUFJLENBQUNWLGdCQUFnQixDQUFDO1FBQUUvQyxNQUFNLEVBQUUsTUFBTTtRQUFFVixVQUFVO1FBQUVZLEtBQUssRUFBRSxRQUFRO1FBQUVEO01BQVEsQ0FBQyxFQUFFK0MsT0FBTyxDQUFDO01BQzFHLE1BQU1XLElBQUksR0FBRyxNQUFNLElBQUFlLHNCQUFZLEVBQUNqQixHQUFHLENBQUM7TUFDcEMsT0FBT3hKLFVBQVUsQ0FBQzRkLG1CQUFtQixDQUFDbFUsSUFBSSxDQUFDO0lBQzdDLENBQUM7SUFFRCxNQUFNbVUsVUFBVSxHQUFHLElBQUksRUFBQztJQUN4QjtJQUNBLE1BQU1DLE9BQU8sR0FBRyxFQUFFO0lBQ2xCLEtBQUssSUFBSUMsQ0FBQyxHQUFHLENBQUMsRUFBRUEsQ0FBQyxHQUFHYixXQUFXLENBQUNoVSxNQUFNLEVBQUU2VSxDQUFDLElBQUlGLFVBQVUsRUFBRTtNQUN2REMsT0FBTyxDQUFDelEsSUFBSSxDQUFDNlAsV0FBVyxDQUFDYyxLQUFLLENBQUNELENBQUMsRUFBRUEsQ0FBQyxHQUFHRixVQUFVLENBQUMsQ0FBQztJQUNwRDtJQUVBLE1BQU1JLFlBQVksR0FBRyxNQUFNaEosT0FBTyxDQUFDQyxHQUFHLENBQUM0SSxPQUFPLENBQUNoTCxHQUFHLENBQUN1SyxnQkFBZ0IsQ0FBQyxDQUFDO0lBQ3JFLE9BQU9ZLFlBQVksQ0FBQ0MsSUFBSSxDQUFDLENBQUM7RUFDNUI7RUFFQSxNQUFNQyxzQkFBc0JBLENBQUM5WSxVQUFrQixFQUFFQyxVQUFrQixFQUFpQjtJQUNsRixJQUFJLENBQUMsSUFBQStFLHlCQUFpQixFQUFDaEYsVUFBVSxDQUFDLEVBQUU7TUFDbEMsTUFBTSxJQUFJakcsTUFBTSxDQUFDZ2Ysc0JBQXNCLENBQUMsdUJBQXVCLEdBQUcvWSxVQUFVLENBQUM7SUFDL0U7SUFDQSxJQUFJLENBQUMsSUFBQXFILHlCQUFpQixFQUFDcEgsVUFBVSxDQUFDLEVBQUU7TUFDbEMsTUFBTSxJQUFJbEcsTUFBTSxDQUFDdU4sc0JBQXNCLENBQUUsd0JBQXVCckgsVUFBVyxFQUFDLENBQUM7SUFDL0U7SUFDQSxNQUFNK1ksY0FBYyxHQUFHLE1BQU0sSUFBSSxDQUFDak0sWUFBWSxDQUFDL00sVUFBVSxFQUFFQyxVQUFVLENBQUM7SUFDdEUsTUFBTVMsTUFBTSxHQUFHLFFBQVE7SUFDdkIsTUFBTUUsS0FBSyxHQUFJLFlBQVdvWSxjQUFlLEVBQUM7SUFDMUMsTUFBTSxJQUFJLENBQUMvVSxvQkFBb0IsQ0FBQztNQUFFdkQsTUFBTTtNQUFFVixVQUFVO01BQUVDLFVBQVU7TUFBRVc7SUFBTSxDQUFDLEVBQUUsRUFBRSxFQUFFLENBQUMsR0FBRyxDQUFDLENBQUM7RUFDdkY7RUFFQSxNQUFjcVksWUFBWUEsQ0FDeEJDLGdCQUF3QixFQUN4QkMsZ0JBQXdCLEVBQ3hCQyw2QkFBcUMsRUFDckNDLFVBQWtDLEVBQ2xDO0lBQ0EsSUFBSSxPQUFPQSxVQUFVLElBQUksVUFBVSxFQUFFO01BQ25DQSxVQUFVLEdBQUcsSUFBSTtJQUNuQjtJQUVBLElBQUksQ0FBQyxJQUFBclUseUJBQWlCLEVBQUNrVSxnQkFBZ0IsQ0FBQyxFQUFFO01BQ3hDLE1BQU0sSUFBSW5mLE1BQU0sQ0FBQ2tMLHNCQUFzQixDQUFDLHVCQUF1QixHQUFHaVUsZ0JBQWdCLENBQUM7SUFDckY7SUFDQSxJQUFJLENBQUMsSUFBQTdSLHlCQUFpQixFQUFDOFIsZ0JBQWdCLENBQUMsRUFBRTtNQUN4QyxNQUFNLElBQUlwZixNQUFNLENBQUN1TixzQkFBc0IsQ0FBRSx3QkFBdUI2UixnQkFBaUIsRUFBQyxDQUFDO0lBQ3JGO0lBQ0EsSUFBSSxDQUFDLElBQUF0YixnQkFBUSxFQUFDdWIsNkJBQTZCLENBQUMsRUFBRTtNQUM1QyxNQUFNLElBQUl4WixTQUFTLENBQUMsMERBQTBELENBQUM7SUFDakY7SUFDQSxJQUFJd1osNkJBQTZCLEtBQUssRUFBRSxFQUFFO01BQ3hDLE1BQU0sSUFBSXJmLE1BQU0sQ0FBQzJRLGtCQUFrQixDQUFFLHFCQUFvQixDQUFDO0lBQzVEO0lBRUEsSUFBSTJPLFVBQVUsSUFBSSxJQUFJLElBQUksRUFBRUEsVUFBVSxZQUFZQyw4QkFBYyxDQUFDLEVBQUU7TUFDakUsTUFBTSxJQUFJMVosU0FBUyxDQUFDLCtDQUErQyxDQUFDO0lBQ3RFO0lBRUEsTUFBTWUsT0FBdUIsR0FBRyxDQUFDLENBQUM7SUFDbENBLE9BQU8sQ0FBQyxtQkFBbUIsQ0FBQyxHQUFHLElBQUFLLHlCQUFpQixFQUFDb1ksNkJBQTZCLENBQUM7SUFFL0UsSUFBSUMsVUFBVSxFQUFFO01BQ2QsSUFBSUEsVUFBVSxDQUFDRSxRQUFRLEtBQUssRUFBRSxFQUFFO1FBQzlCNVksT0FBTyxDQUFDLHFDQUFxQyxDQUFDLEdBQUcwWSxVQUFVLENBQUNFLFFBQVE7TUFDdEU7TUFDQSxJQUFJRixVQUFVLENBQUNHLFVBQVUsS0FBSyxFQUFFLEVBQUU7UUFDaEM3WSxPQUFPLENBQUMsdUNBQXVDLENBQUMsR0FBRzBZLFVBQVUsQ0FBQ0csVUFBVTtNQUMxRTtNQUNBLElBQUlILFVBQVUsQ0FBQ0ksU0FBUyxLQUFLLEVBQUUsRUFBRTtRQUMvQjlZLE9BQU8sQ0FBQyw0QkFBNEIsQ0FBQyxHQUFHMFksVUFBVSxDQUFDSSxTQUFTO01BQzlEO01BQ0EsSUFBSUosVUFBVSxDQUFDSyxlQUFlLEtBQUssRUFBRSxFQUFFO1FBQ3JDL1ksT0FBTyxDQUFDLGlDQUFpQyxDQUFDLEdBQUcwWSxVQUFVLENBQUNLLGVBQWU7TUFDekU7SUFDRjtJQUVBLE1BQU1oWixNQUFNLEdBQUcsS0FBSztJQUVwQixNQUFNeUQsR0FBRyxHQUFHLE1BQU0sSUFBSSxDQUFDVixnQkFBZ0IsQ0FBQztNQUN0Qy9DLE1BQU07TUFDTlYsVUFBVSxFQUFFa1osZ0JBQWdCO01BQzVCalosVUFBVSxFQUFFa1osZ0JBQWdCO01BQzVCeFk7SUFDRixDQUFDLENBQUM7SUFDRixNQUFNMEQsSUFBSSxHQUFHLE1BQU0sSUFBQWUsc0JBQVksRUFBQ2pCLEdBQUcsQ0FBQztJQUNwQyxPQUFPeEosVUFBVSxDQUFDZ2YsZUFBZSxDQUFDdFYsSUFBSSxDQUFDO0VBQ3pDO0VBRUEsTUFBY3VWLFlBQVlBLENBQ3hCQyxZQUErQixFQUMvQkMsVUFBa0MsRUFDTDtJQUM3QixJQUFJLEVBQUVELFlBQVksWUFBWUUsMEJBQWlCLENBQUMsRUFBRTtNQUNoRCxNQUFNLElBQUloZ0IsTUFBTSxDQUFDMkQsb0JBQW9CLENBQUMsZ0RBQWdELENBQUM7SUFDekY7SUFDQSxJQUFJLEVBQUVvYyxVQUFVLFlBQVlFLCtCQUFzQixDQUFDLEVBQUU7TUFDbkQsTUFBTSxJQUFJamdCLE1BQU0sQ0FBQzJELG9CQUFvQixDQUFDLG1EQUFtRCxDQUFDO0lBQzVGO0lBQ0EsSUFBSSxDQUFDb2MsVUFBVSxDQUFDRyxRQUFRLENBQUMsQ0FBQyxFQUFFO01BQzFCLE9BQU9ySyxPQUFPLENBQUNHLE1BQU0sQ0FBQyxDQUFDO0lBQ3pCO0lBQ0EsSUFBSSxDQUFDK0osVUFBVSxDQUFDRyxRQUFRLENBQUMsQ0FBQyxFQUFFO01BQzFCLE9BQU9ySyxPQUFPLENBQUNHLE1BQU0sQ0FBQyxDQUFDO0lBQ3pCO0lBRUEsTUFBTXBQLE9BQU8sR0FBR2xGLE1BQU0sQ0FBQytGLE1BQU0sQ0FBQyxDQUFDLENBQUMsRUFBRXFZLFlBQVksQ0FBQ0ssVUFBVSxDQUFDLENBQUMsRUFBRUosVUFBVSxDQUFDSSxVQUFVLENBQUMsQ0FBQyxDQUFDO0lBRXJGLE1BQU1sYSxVQUFVLEdBQUc4WixVQUFVLENBQUNLLE1BQU07SUFDcEMsTUFBTWxhLFVBQVUsR0FBRzZaLFVBQVUsQ0FBQ3JlLE1BQU07SUFFcEMsTUFBTWlGLE1BQU0sR0FBRyxLQUFLO0lBRXBCLE1BQU15RCxHQUFHLEdBQUcsTUFBTSxJQUFJLENBQUNWLGdCQUFnQixDQUFDO01BQUUvQyxNQUFNO01BQUVWLFVBQVU7TUFBRUMsVUFBVTtNQUFFVTtJQUFRLENBQUMsQ0FBQztJQUNwRixNQUFNMEQsSUFBSSxHQUFHLE1BQU0sSUFBQWUsc0JBQVksRUFBQ2pCLEdBQUcsQ0FBQztJQUNwQyxNQUFNaVcsT0FBTyxHQUFHemYsVUFBVSxDQUFDZ2YsZUFBZSxDQUFDdFYsSUFBSSxDQUFDO0lBQ2hELE1BQU1nVyxVQUErQixHQUFHbFcsR0FBRyxDQUFDeEQsT0FBTztJQUVuRCxNQUFNMlosZUFBZSxHQUFHRCxVQUFVLElBQUlBLFVBQVUsQ0FBQyxnQkFBZ0IsQ0FBQztJQUNsRSxNQUFNcFIsSUFBSSxHQUFHLE9BQU9xUixlQUFlLEtBQUssUUFBUSxHQUFHQSxlQUFlLEdBQUdwZCxTQUFTO0lBRTlFLE9BQU87TUFDTGlkLE1BQU0sRUFBRUwsVUFBVSxDQUFDSyxNQUFNO01BQ3pCcEYsR0FBRyxFQUFFK0UsVUFBVSxDQUFDcmUsTUFBTTtNQUN0QjhlLFlBQVksRUFBRUgsT0FBTyxDQUFDdlEsWUFBWTtNQUNsQzJRLFFBQVEsRUFBRSxJQUFBNVEsdUJBQWUsRUFBQ3lRLFVBQTRCLENBQUM7TUFDdkRsQyxTQUFTLEVBQUUsSUFBQXBPLG9CQUFZLEVBQUNzUSxVQUE0QixDQUFDO01BQ3JESSxlQUFlLEVBQUUsSUFBQUMsMEJBQWtCLEVBQUNMLFVBQTRCLENBQUM7TUFDakVNLElBQUksRUFBRSxJQUFBM1Esb0JBQVksRUFBQ3FRLFVBQVUsQ0FBQzVSLElBQUksQ0FBQztNQUNuQ21TLElBQUksRUFBRTNSO0lBQ1IsQ0FBQztFQUNIO0VBU0EsTUFBTTRSLFVBQVVBLENBQUMsR0FBR0MsT0FBeUIsRUFBNkI7SUFDeEUsSUFBSSxPQUFPQSxPQUFPLENBQUMsQ0FBQyxDQUFDLEtBQUssUUFBUSxFQUFFO01BQ2xDLE1BQU0sQ0FBQzVCLGdCQUFnQixFQUFFQyxnQkFBZ0IsRUFBRUMsNkJBQTZCLEVBQUVDLFVBQVUsQ0FBQyxHQUFHeUIsT0FLdkY7TUFDRCxPQUFPLE1BQU0sSUFBSSxDQUFDN0IsWUFBWSxDQUFDQyxnQkFBZ0IsRUFBRUMsZ0JBQWdCLEVBQUVDLDZCQUE2QixFQUFFQyxVQUFVLENBQUM7SUFDL0c7SUFDQSxNQUFNLENBQUMwQixNQUFNLEVBQUVDLElBQUksQ0FBQyxHQUFHRixPQUFzRDtJQUM3RSxPQUFPLE1BQU0sSUFBSSxDQUFDbEIsWUFBWSxDQUFDbUIsTUFBTSxFQUFFQyxJQUFJLENBQUM7RUFDOUM7RUFFQSxNQUFNQyxVQUFVQSxDQUNkQyxVQU1DLEVBQ0R4WCxPQUFnQixFQUNoQjtJQUNBLE1BQU07TUFBRTFELFVBQVU7TUFBRUMsVUFBVTtNQUFFa2IsUUFBUTtNQUFFakwsVUFBVTtNQUFFdlA7SUFBUSxDQUFDLEdBQUd1YSxVQUFVO0lBRTVFLE1BQU14YSxNQUFNLEdBQUcsS0FBSztJQUNwQixNQUFNRSxLQUFLLEdBQUksWUFBV3VhLFFBQVMsZUFBY2pMLFVBQVcsRUFBQztJQUM3RCxNQUFNcEQsY0FBYyxHQUFHO01BQUVwTSxNQUFNO01BQUVWLFVBQVU7TUFBRUMsVUFBVSxFQUFFQSxVQUFVO01BQUVXLEtBQUs7TUFBRUQ7SUFBUSxDQUFDO0lBQ3JGLE1BQU13RCxHQUFHLEdBQUcsTUFBTSxJQUFJLENBQUNWLGdCQUFnQixDQUFDcUosY0FBYyxFQUFFcEosT0FBTyxDQUFDO0lBQ2hFLE1BQU1XLElBQUksR0FBRyxNQUFNLElBQUFlLHNCQUFZLEVBQUNqQixHQUFHLENBQUM7SUFDcEMsTUFBTWlYLE9BQU8sR0FBRyxJQUFBQywyQkFBZ0IsRUFBQ2hYLElBQUksQ0FBQztJQUN0QyxPQUFPO01BQ0xvRSxJQUFJLEVBQUUsSUFBQXVCLG9CQUFZLEVBQUNvUixPQUFPLENBQUN4TixJQUFJLENBQUM7TUFDaENoUyxHQUFHLEVBQUVxRSxVQUFVO01BQ2YwTixJQUFJLEVBQUV1QztJQUNSLENBQUM7RUFDSDtFQUVBLE1BQU1vTCxhQUFhQSxDQUNqQkMsYUFBcUMsRUFDckNDLGFBQWtDLEVBQ2dFO0lBQ2xHLE1BQU1DLGlCQUFpQixHQUFHRCxhQUFhLENBQUMzWCxNQUFNO0lBRTlDLElBQUksQ0FBQ2lVLEtBQUssQ0FBQ0MsT0FBTyxDQUFDeUQsYUFBYSxDQUFDLEVBQUU7TUFDakMsTUFBTSxJQUFJemhCLE1BQU0sQ0FBQzJELG9CQUFvQixDQUFDLG9EQUFvRCxDQUFDO0lBQzdGO0lBQ0EsSUFBSSxFQUFFNmQsYUFBYSxZQUFZdkIsK0JBQXNCLENBQUMsRUFBRTtNQUN0RCxNQUFNLElBQUlqZ0IsTUFBTSxDQUFDMkQsb0JBQW9CLENBQUMsbURBQW1ELENBQUM7SUFDNUY7SUFFQSxJQUFJK2QsaUJBQWlCLEdBQUcsQ0FBQyxJQUFJQSxpQkFBaUIsR0FBR0Msd0JBQWdCLENBQUNDLGVBQWUsRUFBRTtNQUNqRixNQUFNLElBQUk1aEIsTUFBTSxDQUFDMkQsb0JBQW9CLENBQ2xDLHlDQUF3Q2dlLHdCQUFnQixDQUFDQyxlQUFnQixrQkFDNUUsQ0FBQztJQUNIO0lBRUEsS0FBSyxJQUFJakQsQ0FBQyxHQUFHLENBQUMsRUFBRUEsQ0FBQyxHQUFHK0MsaUJBQWlCLEVBQUUvQyxDQUFDLEVBQUUsRUFBRTtNQUMxQyxNQUFNa0QsSUFBSSxHQUFHSixhQUFhLENBQUM5QyxDQUFDLENBQXNCO01BQ2xELElBQUksQ0FBQ2tELElBQUksQ0FBQzNCLFFBQVEsQ0FBQyxDQUFDLEVBQUU7UUFDcEIsT0FBTyxLQUFLO01BQ2Q7SUFDRjtJQUVBLElBQUksQ0FBRXNCLGFBQWEsQ0FBNEJ0QixRQUFRLENBQUMsQ0FBQyxFQUFFO01BQ3pELE9BQU8sS0FBSztJQUNkO0lBRUEsTUFBTTRCLGNBQWMsR0FBSUMsU0FBNEIsSUFBSztNQUN2RCxJQUFJdFMsUUFBUSxHQUFHLENBQUMsQ0FBQztNQUNqQixJQUFJLENBQUMzSixPQUFDLENBQUNLLE9BQU8sQ0FBQzRiLFNBQVMsQ0FBQ0MsU0FBUyxDQUFDLEVBQUU7UUFDbkN2UyxRQUFRLEdBQUc7VUFDVE0sU0FBUyxFQUFFZ1MsU0FBUyxDQUFDQztRQUN2QixDQUFDO01BQ0g7TUFDQSxPQUFPdlMsUUFBUTtJQUNqQixDQUFDO0lBQ0QsTUFBTXdTLGNBQXdCLEdBQUcsRUFBRTtJQUNuQyxJQUFJQyxTQUFTLEdBQUcsQ0FBQztJQUNqQixJQUFJQyxVQUFVLEdBQUcsQ0FBQztJQUVsQixNQUFNQyxjQUFjLEdBQUdYLGFBQWEsQ0FBQy9OLEdBQUcsQ0FBRTJPLE9BQU8sSUFDL0MsSUFBSSxDQUFDOVQsVUFBVSxDQUFDOFQsT0FBTyxDQUFDakMsTUFBTSxFQUFFaUMsT0FBTyxDQUFDM2dCLE1BQU0sRUFBRW9nQixjQUFjLENBQUNPLE9BQU8sQ0FBQyxDQUN6RSxDQUFDO0lBRUQsTUFBTUMsY0FBYyxHQUFHLE1BQU16TSxPQUFPLENBQUNDLEdBQUcsQ0FBQ3NNLGNBQWMsQ0FBQztJQUV4RCxNQUFNRyxjQUFjLEdBQUdELGNBQWMsQ0FBQzVPLEdBQUcsQ0FBQyxDQUFDOE8sV0FBVyxFQUFFQyxLQUFLLEtBQUs7TUFDaEUsTUFBTVYsU0FBd0MsR0FBR04sYUFBYSxDQUFDZ0IsS0FBSyxDQUFDO01BRXJFLElBQUlDLFdBQVcsR0FBR0YsV0FBVyxDQUFDdFQsSUFBSTtNQUNsQztNQUNBO01BQ0EsSUFBSTZTLFNBQVMsSUFBSUEsU0FBUyxDQUFDWSxVQUFVLEVBQUU7UUFDckM7UUFDQTtRQUNBO1FBQ0EsTUFBTUMsUUFBUSxHQUFHYixTQUFTLENBQUNjLEtBQUs7UUFDaEMsTUFBTUMsTUFBTSxHQUFHZixTQUFTLENBQUNnQixHQUFHO1FBQzVCLElBQUlELE1BQU0sSUFBSUosV0FBVyxJQUFJRSxRQUFRLEdBQUcsQ0FBQyxFQUFFO1VBQ3pDLE1BQU0sSUFBSTVpQixNQUFNLENBQUMyRCxvQkFBb0IsQ0FDbEMsa0JBQWlCOGUsS0FBTSxpQ0FBZ0NHLFFBQVMsS0FBSUUsTUFBTyxjQUFhSixXQUFZLEdBQ3ZHLENBQUM7UUFDSDtRQUNBQSxXQUFXLEdBQUdJLE1BQU0sR0FBR0YsUUFBUSxHQUFHLENBQUM7TUFDckM7O01BRUE7TUFDQSxJQUFJRixXQUFXLEdBQUdmLHdCQUFnQixDQUFDcUIsaUJBQWlCLElBQUlQLEtBQUssR0FBR2YsaUJBQWlCLEdBQUcsQ0FBQyxFQUFFO1FBQ3JGLE1BQU0sSUFBSTFoQixNQUFNLENBQUMyRCxvQkFBb0IsQ0FDbEMsa0JBQWlCOGUsS0FBTSxrQkFBaUJDLFdBQVksZ0NBQ3ZELENBQUM7TUFDSDs7TUFFQTtNQUNBUixTQUFTLElBQUlRLFdBQVc7TUFDeEIsSUFBSVIsU0FBUyxHQUFHUCx3QkFBZ0IsQ0FBQ3NCLDZCQUE2QixFQUFFO1FBQzlELE1BQU0sSUFBSWpqQixNQUFNLENBQUMyRCxvQkFBb0IsQ0FBRSxvQ0FBbUN1ZSxTQUFVLFdBQVUsQ0FBQztNQUNqRzs7TUFFQTtNQUNBRCxjQUFjLENBQUNRLEtBQUssQ0FBQyxHQUFHQyxXQUFXOztNQUVuQztNQUNBUCxVQUFVLElBQUksSUFBQWUscUJBQWEsRUFBQ1IsV0FBVyxDQUFDO01BQ3hDO01BQ0EsSUFBSVAsVUFBVSxHQUFHUix3QkFBZ0IsQ0FBQ0MsZUFBZSxFQUFFO1FBQ2pELE1BQU0sSUFBSTVoQixNQUFNLENBQUMyRCxvQkFBb0IsQ0FDbEMsbURBQWtEZ2Usd0JBQWdCLENBQUNDLGVBQWdCLFFBQ3RGLENBQUM7TUFDSDtNQUVBLE9BQU9ZLFdBQVc7SUFDcEIsQ0FBQyxDQUFDO0lBRUYsSUFBS0wsVUFBVSxLQUFLLENBQUMsSUFBSUQsU0FBUyxJQUFJUCx3QkFBZ0IsQ0FBQ3dCLGFBQWEsSUFBS2pCLFNBQVMsS0FBSyxDQUFDLEVBQUU7TUFDeEYsT0FBTyxNQUFNLElBQUksQ0FBQ3BCLFVBQVUsQ0FBQ1csYUFBYSxDQUFDLENBQUMsQ0FBQyxFQUF1QkQsYUFBYSxDQUFDLEVBQUM7SUFDckY7O0lBRUE7SUFDQSxLQUFLLElBQUk3QyxDQUFDLEdBQUcsQ0FBQyxFQUFFQSxDQUFDLEdBQUcrQyxpQkFBaUIsRUFBRS9DLENBQUMsRUFBRSxFQUFFO01BQzFDO01BQUU4QyxhQUFhLENBQUM5QyxDQUFDLENBQUMsQ0FBdUJ5RSxTQUFTLEdBQUliLGNBQWMsQ0FBQzVELENBQUMsQ0FBQyxDQUFvQmpRLElBQUk7SUFDakc7SUFFQSxNQUFNMlUsaUJBQWlCLEdBQUdkLGNBQWMsQ0FBQzdPLEdBQUcsQ0FBQyxDQUFDOE8sV0FBVyxFQUFFYyxHQUFHLEtBQUs7TUFDakUsT0FBTyxJQUFBQywyQkFBbUIsRUFBQ3RCLGNBQWMsQ0FBQ3FCLEdBQUcsQ0FBQyxFQUFZN0IsYUFBYSxDQUFDNkIsR0FBRyxDQUFzQixDQUFDO0lBQ3BHLENBQUMsQ0FBQztJQUVGLE1BQU1FLHVCQUF1QixHQUFJN1IsUUFBZ0IsSUFBSztNQUNwRCxNQUFNOFIsb0JBQXdDLEdBQUcsRUFBRTtNQUVuREosaUJBQWlCLENBQUN2YSxPQUFPLENBQUMsQ0FBQzRhLFNBQVMsRUFBRUMsVUFBa0IsS0FBSztRQUMzRCxJQUFJRCxTQUFTLEVBQUU7VUFDYixNQUFNO1lBQUVFLFVBQVUsRUFBRUMsUUFBUTtZQUFFQyxRQUFRLEVBQUVDLE1BQU07WUFBRUMsT0FBTyxFQUFFQztVQUFVLENBQUMsR0FBR1AsU0FBUztVQUVoRixNQUFNUSxTQUFTLEdBQUdQLFVBQVUsR0FBRyxDQUFDLEVBQUM7VUFDakMsTUFBTVEsWUFBWSxHQUFHcEcsS0FBSyxDQUFDdFAsSUFBSSxDQUFDb1YsUUFBUSxDQUFDO1VBRXpDLE1BQU1qZCxPQUFPLEdBQUk2YSxhQUFhLENBQUNrQyxVQUFVLENBQUMsQ0FBdUJ4RCxVQUFVLENBQUMsQ0FBQztVQUU3RWdFLFlBQVksQ0FBQ3JiLE9BQU8sQ0FBQyxDQUFDc2IsVUFBVSxFQUFFQyxVQUFVLEtBQUs7WUFDL0MsTUFBTUMsUUFBUSxHQUFHUCxNQUFNLENBQUNNLFVBQVUsQ0FBQztZQUVuQyxNQUFNRSxTQUFTLEdBQUksR0FBRU4sU0FBUyxDQUFDN0QsTUFBTyxJQUFHNkQsU0FBUyxDQUFDdmlCLE1BQU8sRUFBQztZQUMzRGtGLE9BQU8sQ0FBQyxtQkFBbUIsQ0FBQyxHQUFJLEdBQUUyZCxTQUFVLEVBQUM7WUFDN0MzZCxPQUFPLENBQUMseUJBQXlCLENBQUMsR0FBSSxTQUFRd2QsVUFBVyxJQUFHRSxRQUFTLEVBQUM7WUFFdEUsTUFBTUUsZ0JBQWdCLEdBQUc7Y0FDdkJ2ZSxVQUFVLEVBQUV1YixhQUFhLENBQUNwQixNQUFNO2NBQ2hDbGEsVUFBVSxFQUFFc2IsYUFBYSxDQUFDOWYsTUFBTTtjQUNoQzBmLFFBQVEsRUFBRXpQLFFBQVE7Y0FDbEJ3RSxVQUFVLEVBQUUrTixTQUFTO2NBQ3JCdGQsT0FBTyxFQUFFQSxPQUFPO2NBQ2hCMmQsU0FBUyxFQUFFQTtZQUNiLENBQUM7WUFFRGQsb0JBQW9CLENBQUN4VixJQUFJLENBQUN1VyxnQkFBZ0IsQ0FBQztVQUM3QyxDQUFDLENBQUM7UUFDSjtNQUNGLENBQUMsQ0FBQztNQUVGLE9BQU9mLG9CQUFvQjtJQUM3QixDQUFDO0lBRUQsTUFBTWdCLGNBQWMsR0FBRyxNQUFPQyxVQUE4QixJQUFLO01BQy9ELE1BQU1DLFdBQVcsR0FBR0QsVUFBVSxDQUFDaFIsR0FBRyxDQUFDLE1BQU8zQixJQUFJLElBQUs7UUFDakQsT0FBTyxJQUFJLENBQUNtUCxVQUFVLENBQUNuUCxJQUFJLENBQUM7TUFDOUIsQ0FBQyxDQUFDO01BQ0Y7TUFDQSxPQUFPLE1BQU04RCxPQUFPLENBQUNDLEdBQUcsQ0FBQzZPLFdBQVcsQ0FBQztJQUN2QyxDQUFDO0lBRUQsTUFBTUMsa0JBQWtCLEdBQUcsTUFBT2pULFFBQWdCLElBQUs7TUFDckQsTUFBTStTLFVBQVUsR0FBR2xCLHVCQUF1QixDQUFDN1IsUUFBUSxDQUFDO01BQ3BELE1BQU1rVCxRQUFRLEdBQUcsTUFBTUosY0FBYyxDQUFDQyxVQUFVLENBQUM7TUFDakQsT0FBT0csUUFBUSxDQUFDblIsR0FBRyxDQUFFb1IsUUFBUSxLQUFNO1FBQUVwVyxJQUFJLEVBQUVvVyxRQUFRLENBQUNwVyxJQUFJO1FBQUVrRixJQUFJLEVBQUVrUixRQUFRLENBQUNsUjtNQUFLLENBQUMsQ0FBQyxDQUFDO0lBQ25GLENBQUM7SUFFRCxNQUFNbVIsZ0JBQWdCLEdBQUd2RCxhQUFhLENBQUNyQixVQUFVLENBQUMsQ0FBQztJQUVuRCxNQUFNeE8sUUFBUSxHQUFHLE1BQU0sSUFBSSxDQUFDZ0IsMEJBQTBCLENBQUM2TyxhQUFhLENBQUNwQixNQUFNLEVBQUVvQixhQUFhLENBQUM5ZixNQUFNLEVBQUVxakIsZ0JBQWdCLENBQUM7SUFDcEgsSUFBSTtNQUNGLE1BQU1DLFNBQVMsR0FBRyxNQUFNSixrQkFBa0IsQ0FBQ2pULFFBQVEsQ0FBQztNQUNwRCxPQUFPLE1BQU0sSUFBSSxDQUFDMEIsdUJBQXVCLENBQUNtTyxhQUFhLENBQUNwQixNQUFNLEVBQUVvQixhQUFhLENBQUM5ZixNQUFNLEVBQUVpUSxRQUFRLEVBQUVxVCxTQUFTLENBQUM7SUFDNUcsQ0FBQyxDQUFDLE9BQU90YyxHQUFHLEVBQUU7TUFDWixPQUFPLE1BQU0sSUFBSSxDQUFDb0ssb0JBQW9CLENBQUMwTyxhQUFhLENBQUNwQixNQUFNLEVBQUVvQixhQUFhLENBQUM5ZixNQUFNLEVBQUVpUSxRQUFRLENBQUM7SUFDOUY7RUFDRjtFQUVBLE1BQU1zVCxZQUFZQSxDQUNoQnRlLE1BQWMsRUFDZFYsVUFBa0IsRUFDbEJDLFVBQWtCLEVBQ2xCZ2YsT0FBbUQsRUFDbkRDLFNBQXVDLEVBQ3ZDQyxXQUFrQixFQUNEO0lBQUEsSUFBQUMsWUFBQTtJQUNqQixJQUFJLElBQUksQ0FBQ3JnQixTQUFTLEVBQUU7TUFDbEIsTUFBTSxJQUFJaEYsTUFBTSxDQUFDc2xCLHFCQUFxQixDQUFFLGFBQVkzZSxNQUFPLGlEQUFnRCxDQUFDO0lBQzlHO0lBRUEsSUFBSSxDQUFDdWUsT0FBTyxFQUFFO01BQ1pBLE9BQU8sR0FBR0ssZ0NBQXVCO0lBQ25DO0lBQ0EsSUFBSSxDQUFDSixTQUFTLEVBQUU7TUFDZEEsU0FBUyxHQUFHLENBQUMsQ0FBQztJQUNoQjtJQUNBLElBQUksQ0FBQ0MsV0FBVyxFQUFFO01BQ2hCQSxXQUFXLEdBQUcsSUFBSXphLElBQUksQ0FBQyxDQUFDO0lBQzFCOztJQUVBO0lBQ0EsSUFBSXVhLE9BQU8sSUFBSSxPQUFPQSxPQUFPLEtBQUssUUFBUSxFQUFFO01BQzFDLE1BQU0sSUFBSXJmLFNBQVMsQ0FBQyxvQ0FBb0MsQ0FBQztJQUMzRDtJQUNBLElBQUlzZixTQUFTLElBQUksT0FBT0EsU0FBUyxLQUFLLFFBQVEsRUFBRTtNQUM5QyxNQUFNLElBQUl0ZixTQUFTLENBQUMsc0NBQXNDLENBQUM7SUFDN0Q7SUFDQSxJQUFLdWYsV0FBVyxJQUFJLEVBQUVBLFdBQVcsWUFBWXphLElBQUksQ0FBQyxJQUFNeWEsV0FBVyxJQUFJSSxLQUFLLEVBQUFILFlBQUEsR0FBQ0QsV0FBVyxjQUFBQyxZQUFBLHVCQUFYQSxZQUFBLENBQWFqUyxPQUFPLENBQUMsQ0FBQyxDQUFFLEVBQUU7TUFDckcsTUFBTSxJQUFJdk4sU0FBUyxDQUFDLGdEQUFnRCxDQUFDO0lBQ3ZFO0lBRUEsTUFBTWdCLEtBQUssR0FBR3NlLFNBQVMsR0FBR3RsQixFQUFFLENBQUN5SixTQUFTLENBQUM2YixTQUFTLENBQUMsR0FBR2hpQixTQUFTO0lBRTdELElBQUk7TUFDRixNQUFNVSxNQUFNLEdBQUcsTUFBTSxJQUFJLENBQUM0RyxvQkFBb0IsQ0FBQ3hFLFVBQVUsQ0FBQztNQUMxRCxNQUFNLElBQUksQ0FBQytCLG9CQUFvQixDQUFDLENBQUM7TUFDakMsTUFBTTFDLFVBQVUsR0FBRyxJQUFJLENBQUNtQixpQkFBaUIsQ0FBQztRQUFFRSxNQUFNO1FBQUU5QyxNQUFNO1FBQUVvQyxVQUFVO1FBQUVDLFVBQVU7UUFBRVc7TUFBTSxDQUFDLENBQUM7TUFFNUYsT0FBTyxJQUFBNGUsMkJBQWtCLEVBQ3ZCbmdCLFVBQVUsRUFDVixJQUFJLENBQUNULFNBQVMsRUFDZCxJQUFJLENBQUNDLFNBQVMsRUFDZCxJQUFJLENBQUNDLFlBQVksRUFDakJsQixNQUFNLEVBQ051aEIsV0FBVyxFQUNYRixPQUNGLENBQUM7SUFDSCxDQUFDLENBQUMsT0FBT3hjLEdBQUcsRUFBRTtNQUNaLElBQUlBLEdBQUcsWUFBWTFJLE1BQU0sQ0FBQ2tMLHNCQUFzQixFQUFFO1FBQ2hELE1BQU0sSUFBSWxMLE1BQU0sQ0FBQzJELG9CQUFvQixDQUFFLG1DQUFrQ3NDLFVBQVcsR0FBRSxDQUFDO01BQ3pGO01BRUEsTUFBTXlDLEdBQUc7SUFDWDtFQUNGO0VBRUEsTUFBTWdkLGtCQUFrQkEsQ0FDdEJ6ZixVQUFrQixFQUNsQkMsVUFBa0IsRUFDbEJnZixPQUFnQixFQUNoQlMsV0FBeUMsRUFDekNQLFdBQWtCLEVBQ0Q7SUFDakIsSUFBSSxDQUFDLElBQUFuYSx5QkFBaUIsRUFBQ2hGLFVBQVUsQ0FBQyxFQUFFO01BQ2xDLE1BQU0sSUFBSWpHLE1BQU0sQ0FBQ2tMLHNCQUFzQixDQUFDLHVCQUF1QixHQUFHakYsVUFBVSxDQUFDO0lBQy9FO0lBQ0EsSUFBSSxDQUFDLElBQUFxSCx5QkFBaUIsRUFBQ3BILFVBQVUsQ0FBQyxFQUFFO01BQ2xDLE1BQU0sSUFBSWxHLE1BQU0sQ0FBQ3VOLHNCQUFzQixDQUFFLHdCQUF1QnJILFVBQVcsRUFBQyxDQUFDO0lBQy9FO0lBRUEsTUFBTTBmLGdCQUFnQixHQUFHLENBQ3ZCLHVCQUF1QixFQUN2QiwyQkFBMkIsRUFDM0Isa0JBQWtCLEVBQ2xCLHdCQUF3QixFQUN4Qiw4QkFBOEIsRUFDOUIsMkJBQTJCLENBQzVCO0lBQ0RBLGdCQUFnQixDQUFDOWMsT0FBTyxDQUFFK2MsTUFBTSxJQUFLO01BQ25DO01BQ0EsSUFBSUYsV0FBVyxLQUFLeGlCLFNBQVMsSUFBSXdpQixXQUFXLENBQUNFLE1BQU0sQ0FBQyxLQUFLMWlCLFNBQVMsSUFBSSxDQUFDLElBQUFXLGdCQUFRLEVBQUM2aEIsV0FBVyxDQUFDRSxNQUFNLENBQUMsQ0FBQyxFQUFFO1FBQ3BHLE1BQU0sSUFBSWhnQixTQUFTLENBQUUsbUJBQWtCZ2dCLE1BQU8sNkJBQTRCLENBQUM7TUFDN0U7SUFDRixDQUFDLENBQUM7SUFDRixPQUFPLElBQUksQ0FBQ1osWUFBWSxDQUFDLEtBQUssRUFBRWhmLFVBQVUsRUFBRUMsVUFBVSxFQUFFZ2YsT0FBTyxFQUFFUyxXQUFXLEVBQUVQLFdBQVcsQ0FBQztFQUM1RjtFQUVBLE1BQU1VLGtCQUFrQkEsQ0FBQzdmLFVBQWtCLEVBQUVDLFVBQWtCLEVBQUVnZixPQUFnQixFQUFtQjtJQUNsRyxJQUFJLENBQUMsSUFBQWphLHlCQUFpQixFQUFDaEYsVUFBVSxDQUFDLEVBQUU7TUFDbEMsTUFBTSxJQUFJakcsTUFBTSxDQUFDa0wsc0JBQXNCLENBQUUsd0JBQXVCakYsVUFBVyxFQUFDLENBQUM7SUFDL0U7SUFDQSxJQUFJLENBQUMsSUFBQXFILHlCQUFpQixFQUFDcEgsVUFBVSxDQUFDLEVBQUU7TUFDbEMsTUFBTSxJQUFJbEcsTUFBTSxDQUFDdU4sc0JBQXNCLENBQUUsd0JBQXVCckgsVUFBVyxFQUFDLENBQUM7SUFDL0U7SUFFQSxPQUFPLElBQUksQ0FBQytlLFlBQVksQ0FBQyxLQUFLLEVBQUVoZixVQUFVLEVBQUVDLFVBQVUsRUFBRWdmLE9BQU8sQ0FBQztFQUNsRTtFQUVBYSxhQUFhQSxDQUFBLEVBQWU7SUFDMUIsT0FBTyxJQUFJQyxzQkFBVSxDQUFDLENBQUM7RUFDekI7RUFFQSxNQUFNQyxtQkFBbUJBLENBQUNDLFVBQXNCLEVBQTZCO0lBQzNFLElBQUksSUFBSSxDQUFDbGhCLFNBQVMsRUFBRTtNQUNsQixNQUFNLElBQUloRixNQUFNLENBQUNzbEIscUJBQXFCLENBQUMsa0VBQWtFLENBQUM7SUFDNUc7SUFDQSxJQUFJLENBQUMsSUFBQWpoQixnQkFBUSxFQUFDNmhCLFVBQVUsQ0FBQyxFQUFFO01BQ3pCLE1BQU0sSUFBSXJnQixTQUFTLENBQUMsdUNBQXVDLENBQUM7SUFDOUQ7SUFDQSxNQUFNSSxVQUFVLEdBQUdpZ0IsVUFBVSxDQUFDQyxRQUFRLENBQUMzVixNQUFnQjtJQUN2RCxJQUFJO01BQ0YsTUFBTTNNLE1BQU0sR0FBRyxNQUFNLElBQUksQ0FBQzRHLG9CQUFvQixDQUFDeEUsVUFBVSxDQUFDO01BRTFELE1BQU15RSxJQUFJLEdBQUcsSUFBSUMsSUFBSSxDQUFDLENBQUM7TUFDdkIsTUFBTXliLE9BQU8sR0FBRyxJQUFBeGIsb0JBQVksRUFBQ0YsSUFBSSxDQUFDO01BQ2xDLE1BQU0sSUFBSSxDQUFDMUMsb0JBQW9CLENBQUMsQ0FBQztNQUVqQyxJQUFJLENBQUNrZSxVQUFVLENBQUMzTixNQUFNLENBQUM4TixVQUFVLEVBQUU7UUFDakM7UUFDQTtRQUNBLE1BQU1uQixPQUFPLEdBQUcsSUFBSXZhLElBQUksQ0FBQyxDQUFDO1FBQzFCdWEsT0FBTyxDQUFDb0IsVUFBVSxDQUFDZixnQ0FBdUIsQ0FBQztRQUMzQ1csVUFBVSxDQUFDSyxVQUFVLENBQUNyQixPQUFPLENBQUM7TUFDaEM7TUFFQWdCLFVBQVUsQ0FBQzNOLE1BQU0sQ0FBQytHLFVBQVUsQ0FBQ3JSLElBQUksQ0FBQyxDQUFDLElBQUksRUFBRSxhQUFhLEVBQUVtWSxPQUFPLENBQUMsQ0FBQztNQUNqRUYsVUFBVSxDQUFDQyxRQUFRLENBQUMsWUFBWSxDQUFDLEdBQUdDLE9BQU87TUFFM0NGLFVBQVUsQ0FBQzNOLE1BQU0sQ0FBQytHLFVBQVUsQ0FBQ3JSLElBQUksQ0FBQyxDQUFDLElBQUksRUFBRSxrQkFBa0IsRUFBRSxrQkFBa0IsQ0FBQyxDQUFDO01BQ2pGaVksVUFBVSxDQUFDQyxRQUFRLENBQUMsaUJBQWlCLENBQUMsR0FBRyxrQkFBa0I7TUFFM0RELFVBQVUsQ0FBQzNOLE1BQU0sQ0FBQytHLFVBQVUsQ0FBQ3JSLElBQUksQ0FBQyxDQUFDLElBQUksRUFBRSxtQkFBbUIsRUFBRSxJQUFJLENBQUNwSixTQUFTLEdBQUcsR0FBRyxHQUFHLElBQUEyaEIsZ0JBQVEsRUFBQzNpQixNQUFNLEVBQUU2RyxJQUFJLENBQUMsQ0FBQyxDQUFDO01BQzdHd2IsVUFBVSxDQUFDQyxRQUFRLENBQUMsa0JBQWtCLENBQUMsR0FBRyxJQUFJLENBQUN0aEIsU0FBUyxHQUFHLEdBQUcsR0FBRyxJQUFBMmhCLGdCQUFRLEVBQUMzaUIsTUFBTSxFQUFFNkcsSUFBSSxDQUFDO01BRXZGLElBQUksSUFBSSxDQUFDM0YsWUFBWSxFQUFFO1FBQ3JCbWhCLFVBQVUsQ0FBQzNOLE1BQU0sQ0FBQytHLFVBQVUsQ0FBQ3JSLElBQUksQ0FBQyxDQUFDLElBQUksRUFBRSx1QkFBdUIsRUFBRSxJQUFJLENBQUNsSixZQUFZLENBQUMsQ0FBQztRQUNyRm1oQixVQUFVLENBQUNDLFFBQVEsQ0FBQyxzQkFBc0IsQ0FBQyxHQUFHLElBQUksQ0FBQ3BoQixZQUFZO01BQ2pFO01BRUEsTUFBTTBoQixZQUFZLEdBQUdsYyxNQUFNLENBQUNrRSxJQUFJLENBQUNwRixJQUFJLENBQUNDLFNBQVMsQ0FBQzRjLFVBQVUsQ0FBQzNOLE1BQU0sQ0FBQyxDQUFDLENBQUMxUSxRQUFRLENBQUMsUUFBUSxDQUFDO01BRXRGcWUsVUFBVSxDQUFDQyxRQUFRLENBQUM1TixNQUFNLEdBQUdrTyxZQUFZO01BRXpDUCxVQUFVLENBQUNDLFFBQVEsQ0FBQyxpQkFBaUIsQ0FBQyxHQUFHLElBQUFPLCtCQUFzQixFQUFDN2lCLE1BQU0sRUFBRTZHLElBQUksRUFBRSxJQUFJLENBQUM1RixTQUFTLEVBQUUyaEIsWUFBWSxDQUFDO01BQzNHLE1BQU0vZixJQUFJLEdBQUc7UUFDWDdDLE1BQU0sRUFBRUEsTUFBTTtRQUNkb0MsVUFBVSxFQUFFQSxVQUFVO1FBQ3RCVSxNQUFNLEVBQUU7TUFDVixDQUFDO01BQ0QsTUFBTXJCLFVBQVUsR0FBRyxJQUFJLENBQUNtQixpQkFBaUIsQ0FBQ0MsSUFBSSxDQUFDO01BQy9DLE1BQU1pZ0IsT0FBTyxHQUFHLElBQUksQ0FBQ3JqQixJQUFJLElBQUksRUFBRSxJQUFJLElBQUksQ0FBQ0EsSUFBSSxLQUFLLEdBQUcsR0FBRyxFQUFFLEdBQUksSUFBRyxJQUFJLENBQUNBLElBQUksQ0FBQ3VFLFFBQVEsQ0FBQyxDQUFFLEVBQUM7TUFDdEYsTUFBTStlLE1BQU0sR0FBSSxHQUFFdGhCLFVBQVUsQ0FBQ3JCLFFBQVMsS0FBSXFCLFVBQVUsQ0FBQ3ZCLElBQUssR0FBRTRpQixPQUFRLEdBQUVyaEIsVUFBVSxDQUFDL0YsSUFBSyxFQUFDO01BQ3ZGLE9BQU87UUFBRXNuQixPQUFPLEVBQUVELE1BQU07UUFBRVQsUUFBUSxFQUFFRCxVQUFVLENBQUNDO01BQVMsQ0FBQztJQUMzRCxDQUFDLENBQUMsT0FBT3pkLEdBQUcsRUFBRTtNQUNaLElBQUlBLEdBQUcsWUFBWTFJLE1BQU0sQ0FBQ2tMLHNCQUFzQixFQUFFO1FBQ2hELE1BQU0sSUFBSWxMLE1BQU0sQ0FBQzJELG9CQUFvQixDQUFFLG1DQUFrQ3NDLFVBQVcsR0FBRSxDQUFDO01BQ3pGO01BRUEsTUFBTXlDLEdBQUc7SUFDWDtFQUNGO0VBQ0E7RUFDQSxNQUFNb2UsZ0JBQWdCQSxDQUFDN2dCLFVBQWtCLEVBQUV3SyxNQUFlLEVBQUV1RCxNQUFlLEVBQUUrUyxhQUFtQyxFQUFFO0lBQ2hILElBQUksQ0FBQyxJQUFBOWIseUJBQWlCLEVBQUNoRixVQUFVLENBQUMsRUFBRTtNQUNsQyxNQUFNLElBQUlqRyxNQUFNLENBQUNrTCxzQkFBc0IsQ0FBQyx1QkFBdUIsR0FBR2pGLFVBQVUsQ0FBQztJQUMvRTtJQUNBLElBQUksQ0FBQyxJQUFBbkMsZ0JBQVEsRUFBQzJNLE1BQU0sQ0FBQyxFQUFFO01BQ3JCLE1BQU0sSUFBSTVLLFNBQVMsQ0FBQyxtQ0FBbUMsQ0FBQztJQUMxRDtJQUNBLElBQUltTyxNQUFNLElBQUksQ0FBQyxJQUFBbFEsZ0JBQVEsRUFBQ2tRLE1BQU0sQ0FBQyxFQUFFO01BQy9CLE1BQU0sSUFBSW5PLFNBQVMsQ0FBQyxtQ0FBbUMsQ0FBQztJQUMxRDtJQUVBLElBQUlraEIsYUFBYSxJQUFJLENBQUMsSUFBQTFpQixnQkFBUSxFQUFDMGlCLGFBQWEsQ0FBQyxFQUFFO01BQzdDLE1BQU0sSUFBSWxoQixTQUFTLENBQUMsMENBQTBDLENBQUM7SUFDakU7SUFDQSxJQUFJO01BQUVtaEIsU0FBUztNQUFFQyxPQUFPO01BQUVDLGNBQWM7TUFBRUMsZUFBZTtNQUFFdFc7SUFBVSxDQUFDLEdBQUdrVyxhQUFvQztJQUU3RyxJQUFJLENBQUMsSUFBQWpqQixnQkFBUSxFQUFDa2pCLFNBQVMsQ0FBQyxFQUFFO01BQ3hCLE1BQU0sSUFBSW5oQixTQUFTLENBQUMsc0NBQXNDLENBQUM7SUFDN0Q7SUFDQSxJQUFJLENBQUMsSUFBQWdFLGdCQUFRLEVBQUNvZCxPQUFPLENBQUMsRUFBRTtNQUN0QixNQUFNLElBQUlwaEIsU0FBUyxDQUFDLG9DQUFvQyxDQUFDO0lBQzNEO0lBRUEsTUFBTXVNLE9BQU8sR0FBRyxFQUFFO0lBQ2xCO0lBQ0FBLE9BQU8sQ0FBQ25FLElBQUksQ0FBRSxVQUFTLElBQUFvRSxpQkFBUyxFQUFDNUIsTUFBTSxDQUFFLEVBQUMsQ0FBQztJQUMzQzJCLE9BQU8sQ0FBQ25FLElBQUksQ0FBRSxhQUFZLElBQUFvRSxpQkFBUyxFQUFDMlUsU0FBUyxDQUFFLEVBQUMsQ0FBQztJQUNqRDVVLE9BQU8sQ0FBQ25FLElBQUksQ0FBRSxtQkFBa0IsQ0FBQztJQUVqQyxJQUFJaVosY0FBYyxFQUFFO01BQ2xCOVUsT0FBTyxDQUFDbkUsSUFBSSxDQUFFLFVBQVMsQ0FBQztJQUMxQjtJQUVBLElBQUlpWixjQUFjLEVBQUU7TUFDbEI7TUFDQSxJQUFJclcsU0FBUyxFQUFFO1FBQ2J1QixPQUFPLENBQUNuRSxJQUFJLENBQUUsY0FBYTRDLFNBQVUsRUFBQyxDQUFDO01BQ3pDO01BQ0EsSUFBSXNXLGVBQWUsRUFBRTtRQUNuQi9VLE9BQU8sQ0FBQ25FLElBQUksQ0FBRSxxQkFBb0JrWixlQUFnQixFQUFDLENBQUM7TUFDdEQ7SUFDRixDQUFDLE1BQU0sSUFBSW5ULE1BQU0sRUFBRTtNQUNqQkEsTUFBTSxHQUFHLElBQUEzQixpQkFBUyxFQUFDMkIsTUFBTSxDQUFDO01BQzFCNUIsT0FBTyxDQUFDbkUsSUFBSSxDQUFFLFVBQVMrRixNQUFPLEVBQUMsQ0FBQztJQUNsQzs7SUFFQTtJQUNBLElBQUlpVCxPQUFPLEVBQUU7TUFDWCxJQUFJQSxPQUFPLElBQUksSUFBSSxFQUFFO1FBQ25CQSxPQUFPLEdBQUcsSUFBSTtNQUNoQjtNQUNBN1UsT0FBTyxDQUFDbkUsSUFBSSxDQUFFLFlBQVdnWixPQUFRLEVBQUMsQ0FBQztJQUNyQztJQUNBN1UsT0FBTyxDQUFDRyxJQUFJLENBQUMsQ0FBQztJQUNkLElBQUkxTCxLQUFLLEdBQUcsRUFBRTtJQUNkLElBQUl1TCxPQUFPLENBQUN0SSxNQUFNLEdBQUcsQ0FBQyxFQUFFO01BQ3RCakQsS0FBSyxHQUFJLEdBQUV1TCxPQUFPLENBQUNLLElBQUksQ0FBQyxHQUFHLENBQUUsRUFBQztJQUNoQztJQUVBLE1BQU05TCxNQUFNLEdBQUcsS0FBSztJQUNwQixNQUFNeUQsR0FBRyxHQUFHLE1BQU0sSUFBSSxDQUFDVixnQkFBZ0IsQ0FBQztNQUFFL0MsTUFBTTtNQUFFVixVQUFVO01BQUVZO0lBQU0sQ0FBQyxDQUFDO0lBQ3RFLE1BQU15RCxJQUFJLEdBQUcsTUFBTSxJQUFBZSxzQkFBWSxFQUFDakIsR0FBRyxDQUFDO0lBQ3BDLE1BQU1nZCxXQUFXLEdBQUcsSUFBQUMsMkJBQWdCLEVBQUMvYyxJQUFJLENBQUM7SUFDMUMsT0FBTzhjLFdBQVc7RUFDcEI7RUFFQUUsV0FBV0EsQ0FDVHJoQixVQUFrQixFQUNsQndLLE1BQWUsRUFDZjFCLFNBQW1CLEVBQ25Cd1ksUUFBMEMsRUFDaEI7SUFDMUIsSUFBSTlXLE1BQU0sS0FBS3ROLFNBQVMsRUFBRTtNQUN4QnNOLE1BQU0sR0FBRyxFQUFFO0lBQ2I7SUFDQSxJQUFJMUIsU0FBUyxLQUFLNUwsU0FBUyxFQUFFO01BQzNCNEwsU0FBUyxHQUFHLEtBQUs7SUFDbkI7SUFDQSxJQUFJLENBQUMsSUFBQTlELHlCQUFpQixFQUFDaEYsVUFBVSxDQUFDLEVBQUU7TUFDbEMsTUFBTSxJQUFJakcsTUFBTSxDQUFDa0wsc0JBQXNCLENBQUMsdUJBQXVCLEdBQUdqRixVQUFVLENBQUM7SUFDL0U7SUFDQSxJQUFJLENBQUMsSUFBQXlLLHFCQUFhLEVBQUNELE1BQU0sQ0FBQyxFQUFFO01BQzFCLE1BQU0sSUFBSXpRLE1BQU0sQ0FBQzJRLGtCQUFrQixDQUFFLG9CQUFtQkYsTUFBTyxFQUFDLENBQUM7SUFDbkU7SUFDQSxJQUFJLENBQUMsSUFBQTNNLGdCQUFRLEVBQUMyTSxNQUFNLENBQUMsRUFBRTtNQUNyQixNQUFNLElBQUk1SyxTQUFTLENBQUMsbUNBQW1DLENBQUM7SUFDMUQ7SUFDQSxJQUFJLENBQUMsSUFBQWpDLGlCQUFTLEVBQUNtTCxTQUFTLENBQUMsRUFBRTtNQUN6QixNQUFNLElBQUlsSixTQUFTLENBQUMsdUNBQXVDLENBQUM7SUFDOUQ7SUFDQSxJQUFJMGhCLFFBQVEsSUFBSSxDQUFDLElBQUFsakIsZ0JBQVEsRUFBQ2tqQixRQUFRLENBQUMsRUFBRTtNQUNuQyxNQUFNLElBQUkxaEIsU0FBUyxDQUFDLHFDQUFxQyxDQUFDO0lBQzVEO0lBQ0EsSUFBSW1PLE1BQTBCLEdBQUcsRUFBRTtJQUNuQyxJQUFJbkQsU0FBNkIsR0FBRyxFQUFFO0lBQ3RDLElBQUlzVyxlQUFtQyxHQUFHLEVBQUU7SUFDNUMsSUFBSUssT0FBcUIsR0FBRyxFQUFFO0lBQzlCLElBQUl4VyxLQUFLLEdBQUcsS0FBSztJQUNqQixNQUFNQyxVQUEyQixHQUFHLElBQUl6UixNQUFNLENBQUMwUixRQUFRLENBQUM7TUFBRUMsVUFBVSxFQUFFO0lBQUssQ0FBQyxDQUFDO0lBQzdFRixVQUFVLENBQUNHLEtBQUssR0FBRyxZQUFZO01BQzdCO01BQ0EsSUFBSW9XLE9BQU8sQ0FBQzFkLE1BQU0sRUFBRTtRQUNsQm1ILFVBQVUsQ0FBQ2hELElBQUksQ0FBQ3VaLE9BQU8sQ0FBQ25XLEtBQUssQ0FBQyxDQUFDLENBQUM7UUFDaEM7TUFDRjtNQUNBLElBQUlMLEtBQUssRUFBRTtRQUNULE9BQU9DLFVBQVUsQ0FBQ2hELElBQUksQ0FBQyxJQUFJLENBQUM7TUFDOUI7TUFFQSxJQUFJO1FBQ0YsTUFBTThZLGFBQWEsR0FBRztVQUNwQkMsU0FBUyxFQUFFalksU0FBUyxHQUFHLEVBQUUsR0FBRyxHQUFHO1VBQUU7VUFDakNrWSxPQUFPLEVBQUUsSUFBSTtVQUNiQyxjQUFjLEVBQUVLLFFBQVEsYUFBUkEsUUFBUSx1QkFBUkEsUUFBUSxDQUFFTCxjQUFjO1VBQ3hDO1VBQ0FyVyxTQUFTLEVBQUVBLFNBQVM7VUFDcEJzVyxlQUFlLEVBQUVBO1FBQ25CLENBQUM7UUFFRCxNQUFNL2EsTUFBMEIsR0FBRyxNQUFNLElBQUksQ0FBQzBhLGdCQUFnQixDQUFDN2dCLFVBQVUsRUFBRXdLLE1BQU0sRUFBRXVELE1BQU0sRUFBRStTLGFBQWEsQ0FBQztRQUN6RyxJQUFJM2EsTUFBTSxDQUFDNkYsV0FBVyxFQUFFO1VBQ3RCK0IsTUFBTSxHQUFHNUgsTUFBTSxDQUFDcWIsVUFBVSxJQUFJdGtCLFNBQVM7VUFDdkMsSUFBSWlKLE1BQU0sQ0FBQ3lFLFNBQVMsRUFBRTtZQUNwQkEsU0FBUyxHQUFHekUsTUFBTSxDQUFDeUUsU0FBUztVQUM5QjtVQUNBLElBQUl6RSxNQUFNLENBQUMrYSxlQUFlLEVBQUU7WUFDMUJBLGVBQWUsR0FBRy9hLE1BQU0sQ0FBQythLGVBQWU7VUFDMUM7UUFDRixDQUFDLE1BQU07VUFDTG5XLEtBQUssR0FBRyxJQUFJO1FBQ2Q7UUFDQSxJQUFJNUUsTUFBTSxDQUFDb2IsT0FBTyxFQUFFO1VBQ2xCQSxPQUFPLEdBQUdwYixNQUFNLENBQUNvYixPQUFPO1FBQzFCO1FBQ0E7UUFDQXZXLFVBQVUsQ0FBQ0csS0FBSyxDQUFDLENBQUM7TUFDcEIsQ0FBQyxDQUFDLE9BQU8xSSxHQUFHLEVBQUU7UUFDWnVJLFVBQVUsQ0FBQ2UsSUFBSSxDQUFDLE9BQU8sRUFBRXRKLEdBQUcsQ0FBQztNQUMvQjtJQUNGLENBQUM7SUFDRCxPQUFPdUksVUFBVTtFQUNuQjtBQUNGO0FBQUN5VyxPQUFBLENBQUE5a0IsV0FBQSxHQUFBQSxXQUFBIn0=