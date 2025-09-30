"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.parseBucketEncryptionConfig = parseBucketEncryptionConfig;
exports.parseBucketRegion = parseBucketRegion;
exports.parseBucketVersioningConfig = parseBucketVersioningConfig;
exports.parseCompleteMultipart = parseCompleteMultipart;
exports.parseCopyObject = parseCopyObject;
exports.parseError = parseError;
exports.parseInitiateMultipart = parseInitiateMultipart;
exports.parseLifecycleConfig = parseLifecycleConfig;
exports.parseListBucket = parseListBucket;
exports.parseListMultipart = parseListMultipart;
exports.parseListObjects = parseListObjects;
exports.parseListObjectsV2WithMetadata = parseListObjectsV2WithMetadata;
exports.parseListParts = parseListParts;
exports.parseObjectLegalHoldConfig = parseObjectLegalHoldConfig;
exports.parseObjectLockConfig = parseObjectLockConfig;
exports.parseObjectRetentionConfig = parseObjectRetentionConfig;
exports.parseReplicationConfig = parseReplicationConfig;
exports.parseResponseError = parseResponseError;
exports.parseSelectObjectContentResponse = parseSelectObjectContentResponse;
exports.parseTagging = parseTagging;
exports.removeObjectsParser = removeObjectsParser;
exports.uploadPartParser = uploadPartParser;
var _bufferCrc = require("buffer-crc32");
var _fastXmlParser = require("fast-xml-parser");
var errors = _interopRequireWildcard(require("../errors.js"), true);
var _helpers = require("../helpers.js");
var _helper = require("./helper.js");
var _response = require("./response.js");
var _type = require("./type.js");
function _getRequireWildcardCache(nodeInterop) { if (typeof WeakMap !== "function") return null; var cacheBabelInterop = new WeakMap(); var cacheNodeInterop = new WeakMap(); return (_getRequireWildcardCache = function (nodeInterop) { return nodeInterop ? cacheNodeInterop : cacheBabelInterop; })(nodeInterop); }
function _interopRequireWildcard(obj, nodeInterop) { if (!nodeInterop && obj && obj.__esModule) { return obj; } if (obj === null || typeof obj !== "object" && typeof obj !== "function") { return { default: obj }; } var cache = _getRequireWildcardCache(nodeInterop); if (cache && cache.has(obj)) { return cache.get(obj); } var newObj = {}; var hasPropertyDescriptor = Object.defineProperty && Object.getOwnPropertyDescriptor; for (var key in obj) { if (key !== "default" && Object.prototype.hasOwnProperty.call(obj, key)) { var desc = hasPropertyDescriptor ? Object.getOwnPropertyDescriptor(obj, key) : null; if (desc && (desc.get || desc.set)) { Object.defineProperty(newObj, key, desc); } else { newObj[key] = obj[key]; } } } newObj.default = obj; if (cache) { cache.set(obj, newObj); } return newObj; }
// parse XML response for bucket region
function parseBucketRegion(xml) {
  // return region information
  return (0, _helper.parseXml)(xml).LocationConstraint;
}
const fxp = new _fastXmlParser.XMLParser();
const fxpWithoutNumParser = new _fastXmlParser.XMLParser({
  // @ts-ignore
  numberParseOptions: {
    skipLike: /./
  }
});

// Parse XML and return information as Javascript types
// parse error XML response
function parseError(xml, headerInfo) {
  let xmlErr = {};
  const xmlObj = fxp.parse(xml);
  if (xmlObj.Error) {
    xmlErr = xmlObj.Error;
  }
  const e = new errors.S3Error();
  Object.entries(xmlErr).forEach(([key, value]) => {
    e[key.toLowerCase()] = value;
  });
  Object.entries(headerInfo).forEach(([key, value]) => {
    e[key] = value;
  });
  return e;
}

// Generates an Error object depending on http statusCode and XML body
async function parseResponseError(response) {
  const statusCode = response.statusCode;
  let code = '',
    message = '';
  if (statusCode === 301) {
    code = 'MovedPermanently';
    message = 'Moved Permanently';
  } else if (statusCode === 307) {
    code = 'TemporaryRedirect';
    message = 'Are you using the correct endpoint URL?';
  } else if (statusCode === 403) {
    code = 'AccessDenied';
    message = 'Valid and authorized credentials required';
  } else if (statusCode === 404) {
    code = 'NotFound';
    message = 'Not Found';
  } else if (statusCode === 405) {
    code = 'MethodNotAllowed';
    message = 'Method Not Allowed';
  } else if (statusCode === 501) {
    code = 'MethodNotAllowed';
    message = 'Method Not Allowed';
  } else if (statusCode === 503) {
    code = 'SlowDown';
    message = 'Please reduce your request rate.';
  } else {
    const hErrCode = response.headers['x-minio-error-code'];
    const hErrDesc = response.headers['x-minio-error-desc'];
    if (hErrCode && hErrDesc) {
      code = hErrCode;
      message = hErrDesc;
    }
  }
  const headerInfo = {};
  // A value created by S3 compatible server that uniquely identifies the request.
  headerInfo.amzRequestid = response.headers['x-amz-request-id'];
  // A special token that helps troubleshoot API replies and issues.
  headerInfo.amzId2 = response.headers['x-amz-id-2'];

  // Region where the bucket is located. This header is returned only
  // in HEAD bucket and ListObjects response.
  headerInfo.amzBucketRegion = response.headers['x-amz-bucket-region'];
  const xmlString = await (0, _response.readAsString)(response);
  if (xmlString) {
    throw parseError(xmlString, headerInfo);
  }

  // Message should be instantiated for each S3Errors.
  const e = new errors.S3Error(message, {
    cause: headerInfo
  });
  // S3 Error code.
  e.code = code;
  Object.entries(headerInfo).forEach(([key, value]) => {
    // @ts-expect-error force set error properties
    e[key] = value;
  });
  throw e;
}

/**
 * parse XML response for list objects v2 with metadata in a bucket
 */
function parseListObjectsV2WithMetadata(xml) {
  const result = {
    objects: [],
    isTruncated: false,
    nextContinuationToken: ''
  };
  let xmlobj = (0, _helper.parseXml)(xml);
  if (!xmlobj.ListBucketResult) {
    throw new errors.InvalidXMLError('Missing tag: "ListBucketResult"');
  }
  xmlobj = xmlobj.ListBucketResult;
  if (xmlobj.IsTruncated) {
    result.isTruncated = xmlobj.IsTruncated;
  }
  if (xmlobj.NextContinuationToken) {
    result.nextContinuationToken = xmlobj.NextContinuationToken;
  }
  if (xmlobj.Contents) {
    (0, _helper.toArray)(xmlobj.Contents).forEach(content => {
      const name = (0, _helper.sanitizeObjectKey)(content.Key);
      const lastModified = new Date(content.LastModified);
      const etag = (0, _helper.sanitizeETag)(content.ETag);
      const size = content.Size;
      let tags = {};
      if (content.UserTags != null) {
        (0, _helper.toArray)(content.UserTags.split('&')).forEach(tag => {
          const [key, value] = tag.split('=');
          tags[key] = value;
        });
      } else {
        tags = {};
      }
      let metadata;
      if (content.UserMetadata != null) {
        metadata = (0, _helper.toArray)(content.UserMetadata)[0];
      } else {
        metadata = null;
      }
      result.objects.push({
        name,
        lastModified,
        etag,
        size,
        metadata,
        tags
      });
    });
  }
  if (xmlobj.CommonPrefixes) {
    (0, _helper.toArray)(xmlobj.CommonPrefixes).forEach(commonPrefix => {
      result.objects.push({
        prefix: (0, _helper.sanitizeObjectKey)((0, _helper.toArray)(commonPrefix.Prefix)[0]),
        size: 0
      });
    });
  }
  return result;
}
// parse XML response for list parts of an in progress multipart upload
function parseListParts(xml) {
  let xmlobj = (0, _helper.parseXml)(xml);
  const result = {
    isTruncated: false,
    parts: [],
    marker: 0
  };
  if (!xmlobj.ListPartsResult) {
    throw new errors.InvalidXMLError('Missing tag: "ListPartsResult"');
  }
  xmlobj = xmlobj.ListPartsResult;
  if (xmlobj.IsTruncated) {
    result.isTruncated = xmlobj.IsTruncated;
  }
  if (xmlobj.NextPartNumberMarker) {
    result.marker = (0, _helper.toArray)(xmlobj.NextPartNumberMarker)[0] || '';
  }
  if (xmlobj.Part) {
    (0, _helper.toArray)(xmlobj.Part).forEach(p => {
      const part = parseInt((0, _helper.toArray)(p.PartNumber)[0], 10);
      const lastModified = new Date(p.LastModified);
      const etag = p.ETag.replace(/^"/g, '').replace(/"$/g, '').replace(/^&quot;/g, '').replace(/&quot;$/g, '').replace(/^&#34;/g, '').replace(/&#34;$/g, '');
      result.parts.push({
        part,
        lastModified,
        etag,
        size: parseInt(p.Size, 10)
      });
    });
  }
  return result;
}
function parseListBucket(xml) {
  let result = [];
  const listBucketResultParser = new _fastXmlParser.XMLParser({
    parseTagValue: true,
    // Enable parsing of values
    numberParseOptions: {
      leadingZeros: false,
      // Disable number parsing for values with leading zeros
      hex: false,
      // Disable hex number parsing - Invalid bucket name
      skipLike: /^[0-9]+$/ // Skip number parsing if the value consists entirely of digits
    },

    tagValueProcessor: (tagName, tagValue = '') => {
      // Ensure that the Name tag is always treated as a string
      if (tagName === 'Name') {
        return tagValue.toString();
      }
      return tagValue;
    },
    ignoreAttributes: false // Ensure that all attributes are parsed
  });

  const parsedXmlRes = listBucketResultParser.parse(xml);
  if (!parsedXmlRes.ListAllMyBucketsResult) {
    throw new errors.InvalidXMLError('Missing tag: "ListAllMyBucketsResult"');
  }
  const {
    ListAllMyBucketsResult: {
      Buckets = {}
    } = {}
  } = parsedXmlRes;
  if (Buckets.Bucket) {
    result = (0, _helper.toArray)(Buckets.Bucket).map((bucket = {}) => {
      const {
        Name: bucketName,
        CreationDate
      } = bucket;
      const creationDate = new Date(CreationDate);
      return {
        name: bucketName,
        creationDate
      };
    });
  }
  return result;
}
function parseInitiateMultipart(xml) {
  let xmlobj = (0, _helper.parseXml)(xml);
  if (!xmlobj.InitiateMultipartUploadResult) {
    throw new errors.InvalidXMLError('Missing tag: "InitiateMultipartUploadResult"');
  }
  xmlobj = xmlobj.InitiateMultipartUploadResult;
  if (xmlobj.UploadId) {
    return xmlobj.UploadId;
  }
  throw new errors.InvalidXMLError('Missing tag: "UploadId"');
}
function parseReplicationConfig(xml) {
  const xmlObj = (0, _helper.parseXml)(xml);
  const {
    Role,
    Rule
  } = xmlObj.ReplicationConfiguration;
  return {
    ReplicationConfiguration: {
      role: Role,
      rules: (0, _helper.toArray)(Rule)
    }
  };
}
function parseObjectLegalHoldConfig(xml) {
  const xmlObj = (0, _helper.parseXml)(xml);
  return xmlObj.LegalHold;
}
function parseTagging(xml) {
  const xmlObj = (0, _helper.parseXml)(xml);
  let result = [];
  if (xmlObj.Tagging && xmlObj.Tagging.TagSet && xmlObj.Tagging.TagSet.Tag) {
    const tagResult = xmlObj.Tagging.TagSet.Tag;
    // if it is a single tag convert into an array so that the return value is always an array.
    if (Array.isArray(tagResult)) {
      result = [...tagResult];
    } else {
      result.push(tagResult);
    }
  }
  return result;
}

// parse XML response when a multipart upload is completed
function parseCompleteMultipart(xml) {
  const xmlobj = (0, _helper.parseXml)(xml).CompleteMultipartUploadResult;
  if (xmlobj.Location) {
    const location = (0, _helper.toArray)(xmlobj.Location)[0];
    const bucket = (0, _helper.toArray)(xmlobj.Bucket)[0];
    const key = xmlobj.Key;
    const etag = xmlobj.ETag.replace(/^"/g, '').replace(/"$/g, '').replace(/^&quot;/g, '').replace(/&quot;$/g, '').replace(/^&#34;/g, '').replace(/&#34;$/g, '');
    return {
      location,
      bucket,
      key,
      etag
    };
  }
  // Complete Multipart can return XML Error after a 200 OK response
  if (xmlobj.Code && xmlobj.Message) {
    const errCode = (0, _helper.toArray)(xmlobj.Code)[0];
    const errMessage = (0, _helper.toArray)(xmlobj.Message)[0];
    return {
      errCode,
      errMessage
    };
  }
}
// parse XML response for listing in-progress multipart uploads
function parseListMultipart(xml) {
  const result = {
    prefixes: [],
    uploads: [],
    isTruncated: false,
    nextKeyMarker: '',
    nextUploadIdMarker: ''
  };
  let xmlobj = (0, _helper.parseXml)(xml);
  if (!xmlobj.ListMultipartUploadsResult) {
    throw new errors.InvalidXMLError('Missing tag: "ListMultipartUploadsResult"');
  }
  xmlobj = xmlobj.ListMultipartUploadsResult;
  if (xmlobj.IsTruncated) {
    result.isTruncated = xmlobj.IsTruncated;
  }
  if (xmlobj.NextKeyMarker) {
    result.nextKeyMarker = xmlobj.NextKeyMarker;
  }
  if (xmlobj.NextUploadIdMarker) {
    result.nextUploadIdMarker = xmlobj.nextUploadIdMarker || '';
  }
  if (xmlobj.CommonPrefixes) {
    (0, _helper.toArray)(xmlobj.CommonPrefixes).forEach(prefix => {
      // @ts-expect-error index check
      result.prefixes.push({
        prefix: (0, _helper.sanitizeObjectKey)((0, _helper.toArray)(prefix.Prefix)[0])
      });
    });
  }
  if (xmlobj.Upload) {
    (0, _helper.toArray)(xmlobj.Upload).forEach(upload => {
      const uploadItem = {
        key: upload.Key,
        uploadId: upload.UploadId,
        storageClass: upload.StorageClass,
        initiated: new Date(upload.Initiated)
      };
      if (upload.Initiator) {
        uploadItem.initiator = {
          id: upload.Initiator.ID,
          displayName: upload.Initiator.DisplayName
        };
      }
      if (upload.Owner) {
        uploadItem.owner = {
          id: upload.Owner.ID,
          displayName: upload.Owner.DisplayName
        };
      }
      result.uploads.push(uploadItem);
    });
  }
  return result;
}
function parseObjectLockConfig(xml) {
  const xmlObj = (0, _helper.parseXml)(xml);
  let lockConfigResult = {};
  if (xmlObj.ObjectLockConfiguration) {
    lockConfigResult = {
      objectLockEnabled: xmlObj.ObjectLockConfiguration.ObjectLockEnabled
    };
    let retentionResp;
    if (xmlObj.ObjectLockConfiguration && xmlObj.ObjectLockConfiguration.Rule && xmlObj.ObjectLockConfiguration.Rule.DefaultRetention) {
      retentionResp = xmlObj.ObjectLockConfiguration.Rule.DefaultRetention || {};
      lockConfigResult.mode = retentionResp.Mode;
    }
    if (retentionResp) {
      const isUnitYears = retentionResp.Years;
      if (isUnitYears) {
        lockConfigResult.validity = isUnitYears;
        lockConfigResult.unit = _type.RETENTION_VALIDITY_UNITS.YEARS;
      } else {
        lockConfigResult.validity = retentionResp.Days;
        lockConfigResult.unit = _type.RETENTION_VALIDITY_UNITS.DAYS;
      }
    }
  }
  return lockConfigResult;
}
function parseBucketVersioningConfig(xml) {
  const xmlObj = (0, _helper.parseXml)(xml);
  return xmlObj.VersioningConfiguration;
}

// Used only in selectObjectContent API.
// extractHeaderType extracts the first half of the header message, the header type.
function extractHeaderType(stream) {
  const headerNameLen = Buffer.from(stream.read(1)).readUInt8();
  const headerNameWithSeparator = Buffer.from(stream.read(headerNameLen)).toString();
  const splitBySeparator = (headerNameWithSeparator || '').split(':');
  return splitBySeparator.length >= 1 ? splitBySeparator[1] : '';
}
function extractHeaderValue(stream) {
  const bodyLen = Buffer.from(stream.read(2)).readUInt16BE();
  return Buffer.from(stream.read(bodyLen)).toString();
}
function parseSelectObjectContentResponse(res) {
  const selectResults = new _helpers.SelectResults({}); // will be returned

  const responseStream = (0, _helper.readableStream)(res); // convert byte array to a readable responseStream
  // @ts-ignore
  while (responseStream._readableState.length) {
    // Top level responseStream read tracker.
    let msgCrcAccumulator; // accumulate from start of the message till the message crc start.

    const totalByteLengthBuffer = Buffer.from(responseStream.read(4));
    msgCrcAccumulator = _bufferCrc(totalByteLengthBuffer);
    const headerBytesBuffer = Buffer.from(responseStream.read(4));
    msgCrcAccumulator = _bufferCrc(headerBytesBuffer, msgCrcAccumulator);
    const calculatedPreludeCrc = msgCrcAccumulator.readInt32BE(); // use it to check if any CRC mismatch in header itself.

    const preludeCrcBuffer = Buffer.from(responseStream.read(4)); // read 4 bytes    i.e 4+4 =8 + 4 = 12 ( prelude + prelude crc)
    msgCrcAccumulator = _bufferCrc(preludeCrcBuffer, msgCrcAccumulator);
    const totalMsgLength = totalByteLengthBuffer.readInt32BE();
    const headerLength = headerBytesBuffer.readInt32BE();
    const preludeCrcByteValue = preludeCrcBuffer.readInt32BE();
    if (preludeCrcByteValue !== calculatedPreludeCrc) {
      // Handle Header CRC mismatch Error
      throw new Error(`Header Checksum Mismatch, Prelude CRC of ${preludeCrcByteValue} does not equal expected CRC of ${calculatedPreludeCrc}`);
    }
    const headers = {};
    if (headerLength > 0) {
      const headerBytes = Buffer.from(responseStream.read(headerLength));
      msgCrcAccumulator = _bufferCrc(headerBytes, msgCrcAccumulator);
      const headerReaderStream = (0, _helper.readableStream)(headerBytes);
      // @ts-ignore
      while (headerReaderStream._readableState.length) {
        const headerTypeName = extractHeaderType(headerReaderStream);
        headerReaderStream.read(1); // just read and ignore it.
        if (headerTypeName) {
          headers[headerTypeName] = extractHeaderValue(headerReaderStream);
        }
      }
    }
    let payloadStream;
    const payLoadLength = totalMsgLength - headerLength - 16;
    if (payLoadLength > 0) {
      const payLoadBuffer = Buffer.from(responseStream.read(payLoadLength));
      msgCrcAccumulator = _bufferCrc(payLoadBuffer, msgCrcAccumulator);
      // read the checksum early and detect any mismatch so we can avoid unnecessary further processing.
      const messageCrcByteValue = Buffer.from(responseStream.read(4)).readInt32BE();
      const calculatedCrc = msgCrcAccumulator.readInt32BE();
      // Handle message CRC Error
      if (messageCrcByteValue !== calculatedCrc) {
        throw new Error(`Message Checksum Mismatch, Message CRC of ${messageCrcByteValue} does not equal expected CRC of ${calculatedCrc}`);
      }
      payloadStream = (0, _helper.readableStream)(payLoadBuffer);
    }
    const messageType = headers['message-type'];
    switch (messageType) {
      case 'error':
        {
          const errorMessage = headers['error-code'] + ':"' + headers['error-message'] + '"';
          throw new Error(errorMessage);
        }
      case 'event':
        {
          const contentType = headers['content-type'];
          const eventType = headers['event-type'];
          switch (eventType) {
            case 'End':
              {
                selectResults.setResponse(res);
                return selectResults;
              }
            case 'Records':
              {
                var _payloadStream;
                const readData = (_payloadStream = payloadStream) === null || _payloadStream === void 0 ? void 0 : _payloadStream.read(payLoadLength);
                selectResults.setRecords(readData);
                break;
              }
            case 'Progress':
              {
                switch (contentType) {
                  case 'text/xml':
                    {
                      var _payloadStream2;
                      const progressData = (_payloadStream2 = payloadStream) === null || _payloadStream2 === void 0 ? void 0 : _payloadStream2.read(payLoadLength);
                      selectResults.setProgress(progressData.toString());
                      break;
                    }
                  default:
                    {
                      const errorMessage = `Unexpected content-type ${contentType} sent for event-type Progress`;
                      throw new Error(errorMessage);
                    }
                }
              }
              break;
            case 'Stats':
              {
                switch (contentType) {
                  case 'text/xml':
                    {
                      var _payloadStream3;
                      const statsData = (_payloadStream3 = payloadStream) === null || _payloadStream3 === void 0 ? void 0 : _payloadStream3.read(payLoadLength);
                      selectResults.setStats(statsData.toString());
                      break;
                    }
                  default:
                    {
                      const errorMessage = `Unexpected content-type ${contentType} sent for event-type Stats`;
                      throw new Error(errorMessage);
                    }
                }
              }
              break;
            default:
              {
                // Continuation message: Not sure if it is supported. did not find a reference or any message in response.
                // It does not have a payload.
                const warningMessage = `Un implemented event detected  ${messageType}.`;
                // eslint-disable-next-line no-console
                console.warn(warningMessage);
              }
          }
        }
    }
  }
}
function parseLifecycleConfig(xml) {
  const xmlObj = (0, _helper.parseXml)(xml);
  return xmlObj.LifecycleConfiguration;
}
function parseBucketEncryptionConfig(xml) {
  return (0, _helper.parseXml)(xml);
}
function parseObjectRetentionConfig(xml) {
  const xmlObj = (0, _helper.parseXml)(xml);
  const retentionConfig = xmlObj.Retention;
  return {
    mode: retentionConfig.Mode,
    retainUntilDate: retentionConfig.RetainUntilDate
  };
}
function removeObjectsParser(xml) {
  const xmlObj = (0, _helper.parseXml)(xml);
  if (xmlObj.DeleteResult && xmlObj.DeleteResult.Error) {
    // return errors as array always. as the response is object in case of single object passed in removeObjects
    return (0, _helper.toArray)(xmlObj.DeleteResult.Error);
  }
  return [];
}

// parse XML response for copy object
function parseCopyObject(xml) {
  const result = {
    etag: '',
    lastModified: ''
  };
  let xmlobj = (0, _helper.parseXml)(xml);
  if (!xmlobj.CopyObjectResult) {
    throw new errors.InvalidXMLError('Missing tag: "CopyObjectResult"');
  }
  xmlobj = xmlobj.CopyObjectResult;
  if (xmlobj.ETag) {
    result.etag = xmlobj.ETag.replace(/^"/g, '').replace(/"$/g, '').replace(/^&quot;/g, '').replace(/&quot;$/g, '').replace(/^&#34;/g, '').replace(/&#34;$/g, '');
  }
  if (xmlobj.LastModified) {
    result.lastModified = new Date(xmlobj.LastModified);
  }
  return result;
}
const formatObjInfo = (content, opts = {}) => {
  const {
    Key,
    LastModified,
    ETag,
    Size,
    VersionId,
    IsLatest
  } = content;
  if (!(0, _helper.isObject)(opts)) {
    opts = {};
  }
  const name = (0, _helper.sanitizeObjectKey)((0, _helper.toArray)(Key)[0] || '');
  const lastModified = LastModified ? new Date((0, _helper.toArray)(LastModified)[0] || '') : undefined;
  const etag = (0, _helper.sanitizeETag)((0, _helper.toArray)(ETag)[0] || '');
  const size = (0, _helper.sanitizeSize)(Size || '');
  return {
    name,
    lastModified,
    etag,
    size,
    versionId: VersionId,
    isLatest: IsLatest,
    isDeleteMarker: opts.IsDeleteMarker ? opts.IsDeleteMarker : false
  };
};

// parse XML response for list objects in a bucket
function parseListObjects(xml) {
  const result = {
    objects: [],
    isTruncated: false,
    nextMarker: undefined,
    versionIdMarker: undefined,
    keyMarker: undefined
  };
  let isTruncated = false;
  let nextMarker;
  const xmlobj = fxpWithoutNumParser.parse(xml);
  const parseCommonPrefixesEntity = commonPrefixEntry => {
    if (commonPrefixEntry) {
      (0, _helper.toArray)(commonPrefixEntry).forEach(commonPrefix => {
        result.objects.push({
          prefix: (0, _helper.sanitizeObjectKey)((0, _helper.toArray)(commonPrefix.Prefix)[0] || ''),
          size: 0
        });
      });
    }
  };
  const listBucketResult = xmlobj.ListBucketResult;
  const listVersionsResult = xmlobj.ListVersionsResult;
  if (listBucketResult) {
    if (listBucketResult.IsTruncated) {
      isTruncated = listBucketResult.IsTruncated;
    }
    if (listBucketResult.Contents) {
      (0, _helper.toArray)(listBucketResult.Contents).forEach(content => {
        const name = (0, _helper.sanitizeObjectKey)((0, _helper.toArray)(content.Key)[0] || '');
        const lastModified = new Date((0, _helper.toArray)(content.LastModified)[0] || '');
        const etag = (0, _helper.sanitizeETag)((0, _helper.toArray)(content.ETag)[0] || '');
        const size = (0, _helper.sanitizeSize)(content.Size || '');
        result.objects.push({
          name,
          lastModified,
          etag,
          size
        });
      });
    }
    if (listBucketResult.Marker) {
      nextMarker = listBucketResult.Marker;
    }
    if (listBucketResult.NextMarker) {
      nextMarker = listBucketResult.NextMarker;
    } else if (isTruncated && result.objects.length > 0) {
      var _result$objects;
      nextMarker = (_result$objects = result.objects[result.objects.length - 1]) === null || _result$objects === void 0 ? void 0 : _result$objects.name;
    }
    if (listBucketResult.CommonPrefixes) {
      parseCommonPrefixesEntity(listBucketResult.CommonPrefixes);
    }
  }
  if (listVersionsResult) {
    if (listVersionsResult.IsTruncated) {
      isTruncated = listVersionsResult.IsTruncated;
    }
    if (listVersionsResult.Version) {
      (0, _helper.toArray)(listVersionsResult.Version).forEach(content => {
        result.objects.push(formatObjInfo(content));
      });
    }
    if (listVersionsResult.DeleteMarker) {
      (0, _helper.toArray)(listVersionsResult.DeleteMarker).forEach(content => {
        result.objects.push(formatObjInfo(content, {
          IsDeleteMarker: true
        }));
      });
    }
    if (listVersionsResult.NextKeyMarker) {
      result.keyMarker = listVersionsResult.NextKeyMarker;
    }
    if (listVersionsResult.NextVersionIdMarker) {
      result.versionIdMarker = listVersionsResult.NextVersionIdMarker;
    }
    if (listVersionsResult.CommonPrefixes) {
      parseCommonPrefixesEntity(listVersionsResult.CommonPrefixes);
    }
  }
  result.isTruncated = isTruncated;
  if (isTruncated) {
    result.nextMarker = nextMarker;
  }
  return result;
}
function uploadPartParser(xml) {
  const xmlObj = (0, _helper.parseXml)(xml);
  const respEl = xmlObj.CopyPartResult;
  return respEl;
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJfYnVmZmVyQ3JjIiwicmVxdWlyZSIsIl9mYXN0WG1sUGFyc2VyIiwiZXJyb3JzIiwiX2ludGVyb3BSZXF1aXJlV2lsZGNhcmQiLCJfaGVscGVycyIsIl9oZWxwZXIiLCJfcmVzcG9uc2UiLCJfdHlwZSIsIl9nZXRSZXF1aXJlV2lsZGNhcmRDYWNoZSIsIm5vZGVJbnRlcm9wIiwiV2Vha01hcCIsImNhY2hlQmFiZWxJbnRlcm9wIiwiY2FjaGVOb2RlSW50ZXJvcCIsIm9iaiIsIl9fZXNNb2R1bGUiLCJkZWZhdWx0IiwiY2FjaGUiLCJoYXMiLCJnZXQiLCJuZXdPYmoiLCJoYXNQcm9wZXJ0eURlc2NyaXB0b3IiLCJPYmplY3QiLCJkZWZpbmVQcm9wZXJ0eSIsImdldE93blByb3BlcnR5RGVzY3JpcHRvciIsImtleSIsInByb3RvdHlwZSIsImhhc093blByb3BlcnR5IiwiY2FsbCIsImRlc2MiLCJzZXQiLCJwYXJzZUJ1Y2tldFJlZ2lvbiIsInhtbCIsInBhcnNlWG1sIiwiTG9jYXRpb25Db25zdHJhaW50IiwiZnhwIiwiWE1MUGFyc2VyIiwiZnhwV2l0aG91dE51bVBhcnNlciIsIm51bWJlclBhcnNlT3B0aW9ucyIsInNraXBMaWtlIiwicGFyc2VFcnJvciIsImhlYWRlckluZm8iLCJ4bWxFcnIiLCJ4bWxPYmoiLCJwYXJzZSIsIkVycm9yIiwiZSIsIlMzRXJyb3IiLCJlbnRyaWVzIiwiZm9yRWFjaCIsInZhbHVlIiwidG9Mb3dlckNhc2UiLCJwYXJzZVJlc3BvbnNlRXJyb3IiLCJyZXNwb25zZSIsInN0YXR1c0NvZGUiLCJjb2RlIiwibWVzc2FnZSIsImhFcnJDb2RlIiwiaGVhZGVycyIsImhFcnJEZXNjIiwiYW16UmVxdWVzdGlkIiwiYW16SWQyIiwiYW16QnVja2V0UmVnaW9uIiwieG1sU3RyaW5nIiwicmVhZEFzU3RyaW5nIiwiY2F1c2UiLCJwYXJzZUxpc3RPYmplY3RzVjJXaXRoTWV0YWRhdGEiLCJyZXN1bHQiLCJvYmplY3RzIiwiaXNUcnVuY2F0ZWQiLCJuZXh0Q29udGludWF0aW9uVG9rZW4iLCJ4bWxvYmoiLCJMaXN0QnVja2V0UmVzdWx0IiwiSW52YWxpZFhNTEVycm9yIiwiSXNUcnVuY2F0ZWQiLCJOZXh0Q29udGludWF0aW9uVG9rZW4iLCJDb250ZW50cyIsInRvQXJyYXkiLCJjb250ZW50IiwibmFtZSIsInNhbml0aXplT2JqZWN0S2V5IiwiS2V5IiwibGFzdE1vZGlmaWVkIiwiRGF0ZSIsIkxhc3RNb2RpZmllZCIsImV0YWciLCJzYW5pdGl6ZUVUYWciLCJFVGFnIiwic2l6ZSIsIlNpemUiLCJ0YWdzIiwiVXNlclRhZ3MiLCJzcGxpdCIsInRhZyIsIm1ldGFkYXRhIiwiVXNlck1ldGFkYXRhIiwicHVzaCIsIkNvbW1vblByZWZpeGVzIiwiY29tbW9uUHJlZml4IiwicHJlZml4IiwiUHJlZml4IiwicGFyc2VMaXN0UGFydHMiLCJwYXJ0cyIsIm1hcmtlciIsIkxpc3RQYXJ0c1Jlc3VsdCIsIk5leHRQYXJ0TnVtYmVyTWFya2VyIiwiUGFydCIsInAiLCJwYXJ0IiwicGFyc2VJbnQiLCJQYXJ0TnVtYmVyIiwicmVwbGFjZSIsInBhcnNlTGlzdEJ1Y2tldCIsImxpc3RCdWNrZXRSZXN1bHRQYXJzZXIiLCJwYXJzZVRhZ1ZhbHVlIiwibGVhZGluZ1plcm9zIiwiaGV4IiwidGFnVmFsdWVQcm9jZXNzb3IiLCJ0YWdOYW1lIiwidGFnVmFsdWUiLCJ0b1N0cmluZyIsImlnbm9yZUF0dHJpYnV0ZXMiLCJwYXJzZWRYbWxSZXMiLCJMaXN0QWxsTXlCdWNrZXRzUmVzdWx0IiwiQnVja2V0cyIsIkJ1Y2tldCIsIm1hcCIsImJ1Y2tldCIsIk5hbWUiLCJidWNrZXROYW1lIiwiQ3JlYXRpb25EYXRlIiwiY3JlYXRpb25EYXRlIiwicGFyc2VJbml0aWF0ZU11bHRpcGFydCIsIkluaXRpYXRlTXVsdGlwYXJ0VXBsb2FkUmVzdWx0IiwiVXBsb2FkSWQiLCJwYXJzZVJlcGxpY2F0aW9uQ29uZmlnIiwiUm9sZSIsIlJ1bGUiLCJSZXBsaWNhdGlvbkNvbmZpZ3VyYXRpb24iLCJyb2xlIiwicnVsZXMiLCJwYXJzZU9iamVjdExlZ2FsSG9sZENvbmZpZyIsIkxlZ2FsSG9sZCIsInBhcnNlVGFnZ2luZyIsIlRhZ2dpbmciLCJUYWdTZXQiLCJUYWciLCJ0YWdSZXN1bHQiLCJBcnJheSIsImlzQXJyYXkiLCJwYXJzZUNvbXBsZXRlTXVsdGlwYXJ0IiwiQ29tcGxldGVNdWx0aXBhcnRVcGxvYWRSZXN1bHQiLCJMb2NhdGlvbiIsImxvY2F0aW9uIiwiQ29kZSIsIk1lc3NhZ2UiLCJlcnJDb2RlIiwiZXJyTWVzc2FnZSIsInBhcnNlTGlzdE11bHRpcGFydCIsInByZWZpeGVzIiwidXBsb2FkcyIsIm5leHRLZXlNYXJrZXIiLCJuZXh0VXBsb2FkSWRNYXJrZXIiLCJMaXN0TXVsdGlwYXJ0VXBsb2Fkc1Jlc3VsdCIsIk5leHRLZXlNYXJrZXIiLCJOZXh0VXBsb2FkSWRNYXJrZXIiLCJVcGxvYWQiLCJ1cGxvYWQiLCJ1cGxvYWRJdGVtIiwidXBsb2FkSWQiLCJzdG9yYWdlQ2xhc3MiLCJTdG9yYWdlQ2xhc3MiLCJpbml0aWF0ZWQiLCJJbml0aWF0ZWQiLCJJbml0aWF0b3IiLCJpbml0aWF0b3IiLCJpZCIsIklEIiwiZGlzcGxheU5hbWUiLCJEaXNwbGF5TmFtZSIsIk93bmVyIiwib3duZXIiLCJwYXJzZU9iamVjdExvY2tDb25maWciLCJsb2NrQ29uZmlnUmVzdWx0IiwiT2JqZWN0TG9ja0NvbmZpZ3VyYXRpb24iLCJvYmplY3RMb2NrRW5hYmxlZCIsIk9iamVjdExvY2tFbmFibGVkIiwicmV0ZW50aW9uUmVzcCIsIkRlZmF1bHRSZXRlbnRpb24iLCJtb2RlIiwiTW9kZSIsImlzVW5pdFllYXJzIiwiWWVhcnMiLCJ2YWxpZGl0eSIsInVuaXQiLCJSRVRFTlRJT05fVkFMSURJVFlfVU5JVFMiLCJZRUFSUyIsIkRheXMiLCJEQVlTIiwicGFyc2VCdWNrZXRWZXJzaW9uaW5nQ29uZmlnIiwiVmVyc2lvbmluZ0NvbmZpZ3VyYXRpb24iLCJleHRyYWN0SGVhZGVyVHlwZSIsInN0cmVhbSIsImhlYWRlck5hbWVMZW4iLCJCdWZmZXIiLCJmcm9tIiwicmVhZCIsInJlYWRVSW50OCIsImhlYWRlck5hbWVXaXRoU2VwYXJhdG9yIiwic3BsaXRCeVNlcGFyYXRvciIsImxlbmd0aCIsImV4dHJhY3RIZWFkZXJWYWx1ZSIsImJvZHlMZW4iLCJyZWFkVUludDE2QkUiLCJwYXJzZVNlbGVjdE9iamVjdENvbnRlbnRSZXNwb25zZSIsInJlcyIsInNlbGVjdFJlc3VsdHMiLCJTZWxlY3RSZXN1bHRzIiwicmVzcG9uc2VTdHJlYW0iLCJyZWFkYWJsZVN0cmVhbSIsIl9yZWFkYWJsZVN0YXRlIiwibXNnQ3JjQWNjdW11bGF0b3IiLCJ0b3RhbEJ5dGVMZW5ndGhCdWZmZXIiLCJjcmMzMiIsImhlYWRlckJ5dGVzQnVmZmVyIiwiY2FsY3VsYXRlZFByZWx1ZGVDcmMiLCJyZWFkSW50MzJCRSIsInByZWx1ZGVDcmNCdWZmZXIiLCJ0b3RhbE1zZ0xlbmd0aCIsImhlYWRlckxlbmd0aCIsInByZWx1ZGVDcmNCeXRlVmFsdWUiLCJoZWFkZXJCeXRlcyIsImhlYWRlclJlYWRlclN0cmVhbSIsImhlYWRlclR5cGVOYW1lIiwicGF5bG9hZFN0cmVhbSIsInBheUxvYWRMZW5ndGgiLCJwYXlMb2FkQnVmZmVyIiwibWVzc2FnZUNyY0J5dGVWYWx1ZSIsImNhbGN1bGF0ZWRDcmMiLCJtZXNzYWdlVHlwZSIsImVycm9yTWVzc2FnZSIsImNvbnRlbnRUeXBlIiwiZXZlbnRUeXBlIiwic2V0UmVzcG9uc2UiLCJfcGF5bG9hZFN0cmVhbSIsInJlYWREYXRhIiwic2V0UmVjb3JkcyIsIl9wYXlsb2FkU3RyZWFtMiIsInByb2dyZXNzRGF0YSIsInNldFByb2dyZXNzIiwiX3BheWxvYWRTdHJlYW0zIiwic3RhdHNEYXRhIiwic2V0U3RhdHMiLCJ3YXJuaW5nTWVzc2FnZSIsImNvbnNvbGUiLCJ3YXJuIiwicGFyc2VMaWZlY3ljbGVDb25maWciLCJMaWZlY3ljbGVDb25maWd1cmF0aW9uIiwicGFyc2VCdWNrZXRFbmNyeXB0aW9uQ29uZmlnIiwicGFyc2VPYmplY3RSZXRlbnRpb25Db25maWciLCJyZXRlbnRpb25Db25maWciLCJSZXRlbnRpb24iLCJyZXRhaW5VbnRpbERhdGUiLCJSZXRhaW5VbnRpbERhdGUiLCJyZW1vdmVPYmplY3RzUGFyc2VyIiwiRGVsZXRlUmVzdWx0IiwicGFyc2VDb3B5T2JqZWN0IiwiQ29weU9iamVjdFJlc3VsdCIsImZvcm1hdE9iakluZm8iLCJvcHRzIiwiVmVyc2lvbklkIiwiSXNMYXRlc3QiLCJpc09iamVjdCIsInVuZGVmaW5lZCIsInNhbml0aXplU2l6ZSIsInZlcnNpb25JZCIsImlzTGF0ZXN0IiwiaXNEZWxldGVNYXJrZXIiLCJJc0RlbGV0ZU1hcmtlciIsInBhcnNlTGlzdE9iamVjdHMiLCJuZXh0TWFya2VyIiwidmVyc2lvbklkTWFya2VyIiwia2V5TWFya2VyIiwicGFyc2VDb21tb25QcmVmaXhlc0VudGl0eSIsImNvbW1vblByZWZpeEVudHJ5IiwibGlzdEJ1Y2tldFJlc3VsdCIsImxpc3RWZXJzaW9uc1Jlc3VsdCIsIkxpc3RWZXJzaW9uc1Jlc3VsdCIsIk1hcmtlciIsIk5leHRNYXJrZXIiLCJfcmVzdWx0JG9iamVjdHMiLCJWZXJzaW9uIiwiRGVsZXRlTWFya2VyIiwiTmV4dFZlcnNpb25JZE1hcmtlciIsInVwbG9hZFBhcnRQYXJzZXIiLCJyZXNwRWwiLCJDb3B5UGFydFJlc3VsdCJdLCJzb3VyY2VzIjpbInhtbC1wYXJzZXIudHMiXSwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHR5cGUgKiBhcyBodHRwIGZyb20gJ25vZGU6aHR0cCdcbmltcG9ydCB0eXBlIHN0cmVhbSBmcm9tICdub2RlOnN0cmVhbSdcblxuaW1wb3J0IGNyYzMyIGZyb20gJ2J1ZmZlci1jcmMzMidcbmltcG9ydCB7IFhNTFBhcnNlciB9IGZyb20gJ2Zhc3QteG1sLXBhcnNlcidcblxuaW1wb3J0ICogYXMgZXJyb3JzIGZyb20gJy4uL2Vycm9ycy50cydcbmltcG9ydCB7IFNlbGVjdFJlc3VsdHMgfSBmcm9tICcuLi9oZWxwZXJzLnRzJ1xuaW1wb3J0IHsgaXNPYmplY3QsIHBhcnNlWG1sLCByZWFkYWJsZVN0cmVhbSwgc2FuaXRpemVFVGFnLCBzYW5pdGl6ZU9iamVjdEtleSwgc2FuaXRpemVTaXplLCB0b0FycmF5IH0gZnJvbSAnLi9oZWxwZXIudHMnXG5pbXBvcnQgeyByZWFkQXNTdHJpbmcgfSBmcm9tICcuL3Jlc3BvbnNlLnRzJ1xuaW1wb3J0IHR5cGUge1xuICBCdWNrZXRJdGVtRnJvbUxpc3QsXG4gIEJ1Y2tldEl0ZW1XaXRoTWV0YWRhdGEsXG4gIENvbW1vblByZWZpeCxcbiAgQ29weU9iamVjdFJlc3VsdFYxLFxuICBMaXN0QnVja2V0UmVzdWx0VjEsXG4gIE9iamVjdEluZm8sXG4gIE9iamVjdExvY2tJbmZvLFxuICBPYmplY3RSb3dFbnRyeSxcbiAgUmVwbGljYXRpb25Db25maWcsXG4gIFRhZyxcbiAgVGFncyxcbn0gZnJvbSAnLi90eXBlLnRzJ1xuaW1wb3J0IHsgUkVURU5USU9OX1ZBTElESVRZX1VOSVRTIH0gZnJvbSAnLi90eXBlLnRzJ1xuXG4vLyBwYXJzZSBYTUwgcmVzcG9uc2UgZm9yIGJ1Y2tldCByZWdpb25cbmV4cG9ydCBmdW5jdGlvbiBwYXJzZUJ1Y2tldFJlZ2lvbih4bWw6IHN0cmluZyk6IHN0cmluZyB7XG4gIC8vIHJldHVybiByZWdpb24gaW5mb3JtYXRpb25cbiAgcmV0dXJuIHBhcnNlWG1sKHhtbCkuTG9jYXRpb25Db25zdHJhaW50XG59XG5cbmNvbnN0IGZ4cCA9IG5ldyBYTUxQYXJzZXIoKVxuXG5jb25zdCBmeHBXaXRob3V0TnVtUGFyc2VyID0gbmV3IFhNTFBhcnNlcih7XG4gIC8vIEB0cy1pZ25vcmVcbiAgbnVtYmVyUGFyc2VPcHRpb25zOiB7XG4gICAgc2tpcExpa2U6IC8uLyxcbiAgfSxcbn0pXG5cbi8vIFBhcnNlIFhNTCBhbmQgcmV0dXJuIGluZm9ybWF0aW9uIGFzIEphdmFzY3JpcHQgdHlwZXNcbi8vIHBhcnNlIGVycm9yIFhNTCByZXNwb25zZVxuZXhwb3J0IGZ1bmN0aW9uIHBhcnNlRXJyb3IoeG1sOiBzdHJpbmcsIGhlYWRlckluZm86IFJlY29yZDxzdHJpbmcsIHVua25vd24+KSB7XG4gIGxldCB4bWxFcnIgPSB7fVxuICBjb25zdCB4bWxPYmogPSBmeHAucGFyc2UoeG1sKVxuICBpZiAoeG1sT2JqLkVycm9yKSB7XG4gICAgeG1sRXJyID0geG1sT2JqLkVycm9yXG4gIH1cbiAgY29uc3QgZSA9IG5ldyBlcnJvcnMuUzNFcnJvcigpIGFzIHVua25vd24gYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj5cbiAgT2JqZWN0LmVudHJpZXMoeG1sRXJyKS5mb3JFYWNoKChba2V5LCB2YWx1ZV0pID0+IHtcbiAgICBlW2tleS50b0xvd2VyQ2FzZSgpXSA9IHZhbHVlXG4gIH0pXG4gIE9iamVjdC5lbnRyaWVzKGhlYWRlckluZm8pLmZvckVhY2goKFtrZXksIHZhbHVlXSkgPT4ge1xuICAgIGVba2V5XSA9IHZhbHVlXG4gIH0pXG4gIHJldHVybiBlXG59XG5cbi8vIEdlbmVyYXRlcyBhbiBFcnJvciBvYmplY3QgZGVwZW5kaW5nIG9uIGh0dHAgc3RhdHVzQ29kZSBhbmQgWE1MIGJvZHlcbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBwYXJzZVJlc3BvbnNlRXJyb3IocmVzcG9uc2U6IGh0dHAuSW5jb21pbmdNZXNzYWdlKTogUHJvbWlzZTxSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+PiB7XG4gIGNvbnN0IHN0YXR1c0NvZGUgPSByZXNwb25zZS5zdGF0dXNDb2RlXG4gIGxldCBjb2RlID0gJycsXG4gICAgbWVzc2FnZSA9ICcnXG4gIGlmIChzdGF0dXNDb2RlID09PSAzMDEpIHtcbiAgICBjb2RlID0gJ01vdmVkUGVybWFuZW50bHknXG4gICAgbWVzc2FnZSA9ICdNb3ZlZCBQZXJtYW5lbnRseSdcbiAgfSBlbHNlIGlmIChzdGF0dXNDb2RlID09PSAzMDcpIHtcbiAgICBjb2RlID0gJ1RlbXBvcmFyeVJlZGlyZWN0J1xuICAgIG1lc3NhZ2UgPSAnQXJlIHlvdSB1c2luZyB0aGUgY29ycmVjdCBlbmRwb2ludCBVUkw/J1xuICB9IGVsc2UgaWYgKHN0YXR1c0NvZGUgPT09IDQwMykge1xuICAgIGNvZGUgPSAnQWNjZXNzRGVuaWVkJ1xuICAgIG1lc3NhZ2UgPSAnVmFsaWQgYW5kIGF1dGhvcml6ZWQgY3JlZGVudGlhbHMgcmVxdWlyZWQnXG4gIH0gZWxzZSBpZiAoc3RhdHVzQ29kZSA9PT0gNDA0KSB7XG4gICAgY29kZSA9ICdOb3RGb3VuZCdcbiAgICBtZXNzYWdlID0gJ05vdCBGb3VuZCdcbiAgfSBlbHNlIGlmIChzdGF0dXNDb2RlID09PSA0MDUpIHtcbiAgICBjb2RlID0gJ01ldGhvZE5vdEFsbG93ZWQnXG4gICAgbWVzc2FnZSA9ICdNZXRob2QgTm90IEFsbG93ZWQnXG4gIH0gZWxzZSBpZiAoc3RhdHVzQ29kZSA9PT0gNTAxKSB7XG4gICAgY29kZSA9ICdNZXRob2ROb3RBbGxvd2VkJ1xuICAgIG1lc3NhZ2UgPSAnTWV0aG9kIE5vdCBBbGxvd2VkJ1xuICB9IGVsc2UgaWYgKHN0YXR1c0NvZGUgPT09IDUwMykge1xuICAgIGNvZGUgPSAnU2xvd0Rvd24nXG4gICAgbWVzc2FnZSA9ICdQbGVhc2UgcmVkdWNlIHlvdXIgcmVxdWVzdCByYXRlLidcbiAgfSBlbHNlIHtcbiAgICBjb25zdCBoRXJyQ29kZSA9IHJlc3BvbnNlLmhlYWRlcnNbJ3gtbWluaW8tZXJyb3ItY29kZSddIGFzIHN0cmluZ1xuICAgIGNvbnN0IGhFcnJEZXNjID0gcmVzcG9uc2UuaGVhZGVyc1sneC1taW5pby1lcnJvci1kZXNjJ10gYXMgc3RyaW5nXG5cbiAgICBpZiAoaEVyckNvZGUgJiYgaEVyckRlc2MpIHtcbiAgICAgIGNvZGUgPSBoRXJyQ29kZVxuICAgICAgbWVzc2FnZSA9IGhFcnJEZXNjXG4gICAgfVxuICB9XG4gIGNvbnN0IGhlYWRlckluZm86IFJlY29yZDxzdHJpbmcsIHN0cmluZyB8IHVuZGVmaW5lZCB8IG51bGw+ID0ge31cbiAgLy8gQSB2YWx1ZSBjcmVhdGVkIGJ5IFMzIGNvbXBhdGlibGUgc2VydmVyIHRoYXQgdW5pcXVlbHkgaWRlbnRpZmllcyB0aGUgcmVxdWVzdC5cbiAgaGVhZGVySW5mby5hbXpSZXF1ZXN0aWQgPSByZXNwb25zZS5oZWFkZXJzWyd4LWFtei1yZXF1ZXN0LWlkJ10gYXMgc3RyaW5nIHwgdW5kZWZpbmVkXG4gIC8vIEEgc3BlY2lhbCB0b2tlbiB0aGF0IGhlbHBzIHRyb3VibGVzaG9vdCBBUEkgcmVwbGllcyBhbmQgaXNzdWVzLlxuICBoZWFkZXJJbmZvLmFteklkMiA9IHJlc3BvbnNlLmhlYWRlcnNbJ3gtYW16LWlkLTInXSBhcyBzdHJpbmcgfCB1bmRlZmluZWRcblxuICAvLyBSZWdpb24gd2hlcmUgdGhlIGJ1Y2tldCBpcyBsb2NhdGVkLiBUaGlzIGhlYWRlciBpcyByZXR1cm5lZCBvbmx5XG4gIC8vIGluIEhFQUQgYnVja2V0IGFuZCBMaXN0T2JqZWN0cyByZXNwb25zZS5cbiAgaGVhZGVySW5mby5hbXpCdWNrZXRSZWdpb24gPSByZXNwb25zZS5oZWFkZXJzWyd4LWFtei1idWNrZXQtcmVnaW9uJ10gYXMgc3RyaW5nIHwgdW5kZWZpbmVkXG5cbiAgY29uc3QgeG1sU3RyaW5nID0gYXdhaXQgcmVhZEFzU3RyaW5nKHJlc3BvbnNlKVxuXG4gIGlmICh4bWxTdHJpbmcpIHtcbiAgICB0aHJvdyBwYXJzZUVycm9yKHhtbFN0cmluZywgaGVhZGVySW5mbylcbiAgfVxuXG4gIC8vIE1lc3NhZ2Ugc2hvdWxkIGJlIGluc3RhbnRpYXRlZCBmb3IgZWFjaCBTM0Vycm9ycy5cbiAgY29uc3QgZSA9IG5ldyBlcnJvcnMuUzNFcnJvcihtZXNzYWdlLCB7IGNhdXNlOiBoZWFkZXJJbmZvIH0pXG4gIC8vIFMzIEVycm9yIGNvZGUuXG4gIGUuY29kZSA9IGNvZGVcbiAgT2JqZWN0LmVudHJpZXMoaGVhZGVySW5mbykuZm9yRWFjaCgoW2tleSwgdmFsdWVdKSA9PiB7XG4gICAgLy8gQHRzLWV4cGVjdC1lcnJvciBmb3JjZSBzZXQgZXJyb3IgcHJvcGVydGllc1xuICAgIGVba2V5XSA9IHZhbHVlXG4gIH0pXG5cbiAgdGhyb3cgZVxufVxuXG4vKipcbiAqIHBhcnNlIFhNTCByZXNwb25zZSBmb3IgbGlzdCBvYmplY3RzIHYyIHdpdGggbWV0YWRhdGEgaW4gYSBidWNrZXRcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHBhcnNlTGlzdE9iamVjdHNWMldpdGhNZXRhZGF0YSh4bWw6IHN0cmluZykge1xuICBjb25zdCByZXN1bHQ6IHtcbiAgICBvYmplY3RzOiBBcnJheTxCdWNrZXRJdGVtV2l0aE1ldGFkYXRhPlxuICAgIGlzVHJ1bmNhdGVkOiBib29sZWFuXG4gICAgbmV4dENvbnRpbnVhdGlvblRva2VuOiBzdHJpbmdcbiAgfSA9IHtcbiAgICBvYmplY3RzOiBbXSxcbiAgICBpc1RydW5jYXRlZDogZmFsc2UsXG4gICAgbmV4dENvbnRpbnVhdGlvblRva2VuOiAnJyxcbiAgfVxuXG4gIGxldCB4bWxvYmogPSBwYXJzZVhtbCh4bWwpXG4gIGlmICgheG1sb2JqLkxpc3RCdWNrZXRSZXN1bHQpIHtcbiAgICB0aHJvdyBuZXcgZXJyb3JzLkludmFsaWRYTUxFcnJvcignTWlzc2luZyB0YWc6IFwiTGlzdEJ1Y2tldFJlc3VsdFwiJylcbiAgfVxuICB4bWxvYmogPSB4bWxvYmouTGlzdEJ1Y2tldFJlc3VsdFxuICBpZiAoeG1sb2JqLklzVHJ1bmNhdGVkKSB7XG4gICAgcmVzdWx0LmlzVHJ1bmNhdGVkID0geG1sb2JqLklzVHJ1bmNhdGVkXG4gIH1cbiAgaWYgKHhtbG9iai5OZXh0Q29udGludWF0aW9uVG9rZW4pIHtcbiAgICByZXN1bHQubmV4dENvbnRpbnVhdGlvblRva2VuID0geG1sb2JqLk5leHRDb250aW51YXRpb25Ub2tlblxuICB9XG5cbiAgaWYgKHhtbG9iai5Db250ZW50cykge1xuICAgIHRvQXJyYXkoeG1sb2JqLkNvbnRlbnRzKS5mb3JFYWNoKChjb250ZW50KSA9PiB7XG4gICAgICBjb25zdCBuYW1lID0gc2FuaXRpemVPYmplY3RLZXkoY29udGVudC5LZXkpXG4gICAgICBjb25zdCBsYXN0TW9kaWZpZWQgPSBuZXcgRGF0ZShjb250ZW50Lkxhc3RNb2RpZmllZClcbiAgICAgIGNvbnN0IGV0YWcgPSBzYW5pdGl6ZUVUYWcoY29udGVudC5FVGFnKVxuICAgICAgY29uc3Qgc2l6ZSA9IGNvbnRlbnQuU2l6ZVxuXG4gICAgICBsZXQgdGFnczogVGFncyA9IHt9XG4gICAgICBpZiAoY29udGVudC5Vc2VyVGFncyAhPSBudWxsKSB7XG4gICAgICAgIHRvQXJyYXkoY29udGVudC5Vc2VyVGFncy5zcGxpdCgnJicpKS5mb3JFYWNoKCh0YWcpID0+IHtcbiAgICAgICAgICBjb25zdCBba2V5LCB2YWx1ZV0gPSB0YWcuc3BsaXQoJz0nKVxuICAgICAgICAgIHRhZ3Nba2V5XSA9IHZhbHVlXG4gICAgICAgIH0pXG4gICAgICB9IGVsc2Uge1xuICAgICAgICB0YWdzID0ge31cbiAgICAgIH1cblxuICAgICAgbGV0IG1ldGFkYXRhXG4gICAgICBpZiAoY29udGVudC5Vc2VyTWV0YWRhdGEgIT0gbnVsbCkge1xuICAgICAgICBtZXRhZGF0YSA9IHRvQXJyYXkoY29udGVudC5Vc2VyTWV0YWRhdGEpWzBdXG4gICAgICB9IGVsc2Uge1xuICAgICAgICBtZXRhZGF0YSA9IG51bGxcbiAgICAgIH1cbiAgICAgIHJlc3VsdC5vYmplY3RzLnB1c2goeyBuYW1lLCBsYXN0TW9kaWZpZWQsIGV0YWcsIHNpemUsIG1ldGFkYXRhLCB0YWdzIH0pXG4gICAgfSlcbiAgfVxuXG4gIGlmICh4bWxvYmouQ29tbW9uUHJlZml4ZXMpIHtcbiAgICB0b0FycmF5KHhtbG9iai5Db21tb25QcmVmaXhlcykuZm9yRWFjaCgoY29tbW9uUHJlZml4KSA9PiB7XG4gICAgICByZXN1bHQub2JqZWN0cy5wdXNoKHsgcHJlZml4OiBzYW5pdGl6ZU9iamVjdEtleSh0b0FycmF5KGNvbW1vblByZWZpeC5QcmVmaXgpWzBdKSwgc2l6ZTogMCB9KVxuICAgIH0pXG4gIH1cbiAgcmV0dXJuIHJlc3VsdFxufVxuXG5leHBvcnQgdHlwZSBVcGxvYWRlZFBhcnQgPSB7XG4gIHBhcnQ6IG51bWJlclxuICBsYXN0TW9kaWZpZWQ/OiBEYXRlXG4gIGV0YWc6IHN0cmluZ1xuICBzaXplOiBudW1iZXJcbn1cblxuLy8gcGFyc2UgWE1MIHJlc3BvbnNlIGZvciBsaXN0IHBhcnRzIG9mIGFuIGluIHByb2dyZXNzIG11bHRpcGFydCB1cGxvYWRcbmV4cG9ydCBmdW5jdGlvbiBwYXJzZUxpc3RQYXJ0cyh4bWw6IHN0cmluZyk6IHtcbiAgaXNUcnVuY2F0ZWQ6IGJvb2xlYW5cbiAgbWFya2VyOiBudW1iZXJcbiAgcGFydHM6IFVwbG9hZGVkUGFydFtdXG59IHtcbiAgbGV0IHhtbG9iaiA9IHBhcnNlWG1sKHhtbClcbiAgY29uc3QgcmVzdWx0OiB7XG4gICAgaXNUcnVuY2F0ZWQ6IGJvb2xlYW5cbiAgICBtYXJrZXI6IG51bWJlclxuICAgIHBhcnRzOiBVcGxvYWRlZFBhcnRbXVxuICB9ID0ge1xuICAgIGlzVHJ1bmNhdGVkOiBmYWxzZSxcbiAgICBwYXJ0czogW10sXG4gICAgbWFya2VyOiAwLFxuICB9XG4gIGlmICgheG1sb2JqLkxpc3RQYXJ0c1Jlc3VsdCkge1xuICAgIHRocm93IG5ldyBlcnJvcnMuSW52YWxpZFhNTEVycm9yKCdNaXNzaW5nIHRhZzogXCJMaXN0UGFydHNSZXN1bHRcIicpXG4gIH1cbiAgeG1sb2JqID0geG1sb2JqLkxpc3RQYXJ0c1Jlc3VsdFxuICBpZiAoeG1sb2JqLklzVHJ1bmNhdGVkKSB7XG4gICAgcmVzdWx0LmlzVHJ1bmNhdGVkID0geG1sb2JqLklzVHJ1bmNhdGVkXG4gIH1cbiAgaWYgKHhtbG9iai5OZXh0UGFydE51bWJlck1hcmtlcikge1xuICAgIHJlc3VsdC5tYXJrZXIgPSB0b0FycmF5KHhtbG9iai5OZXh0UGFydE51bWJlck1hcmtlcilbMF0gfHwgJydcbiAgfVxuICBpZiAoeG1sb2JqLlBhcnQpIHtcbiAgICB0b0FycmF5KHhtbG9iai5QYXJ0KS5mb3JFYWNoKChwKSA9PiB7XG4gICAgICBjb25zdCBwYXJ0ID0gcGFyc2VJbnQodG9BcnJheShwLlBhcnROdW1iZXIpWzBdLCAxMClcbiAgICAgIGNvbnN0IGxhc3RNb2RpZmllZCA9IG5ldyBEYXRlKHAuTGFzdE1vZGlmaWVkKVxuICAgICAgY29uc3QgZXRhZyA9IHAuRVRhZy5yZXBsYWNlKC9eXCIvZywgJycpXG4gICAgICAgIC5yZXBsYWNlKC9cIiQvZywgJycpXG4gICAgICAgIC5yZXBsYWNlKC9eJnF1b3Q7L2csICcnKVxuICAgICAgICAucmVwbGFjZSgvJnF1b3Q7JC9nLCAnJylcbiAgICAgICAgLnJlcGxhY2UoL14mIzM0Oy9nLCAnJylcbiAgICAgICAgLnJlcGxhY2UoLyYjMzQ7JC9nLCAnJylcbiAgICAgIHJlc3VsdC5wYXJ0cy5wdXNoKHsgcGFydCwgbGFzdE1vZGlmaWVkLCBldGFnLCBzaXplOiBwYXJzZUludChwLlNpemUsIDEwKSB9KVxuICAgIH0pXG4gIH1cbiAgcmV0dXJuIHJlc3VsdFxufVxuXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VMaXN0QnVja2V0KHhtbDogc3RyaW5nKTogQnVja2V0SXRlbUZyb21MaXN0W10ge1xuICBsZXQgcmVzdWx0OiBCdWNrZXRJdGVtRnJvbUxpc3RbXSA9IFtdXG4gIGNvbnN0IGxpc3RCdWNrZXRSZXN1bHRQYXJzZXIgPSBuZXcgWE1MUGFyc2VyKHtcbiAgICBwYXJzZVRhZ1ZhbHVlOiB0cnVlLCAvLyBFbmFibGUgcGFyc2luZyBvZiB2YWx1ZXNcbiAgICBudW1iZXJQYXJzZU9wdGlvbnM6IHtcbiAgICAgIGxlYWRpbmdaZXJvczogZmFsc2UsIC8vIERpc2FibGUgbnVtYmVyIHBhcnNpbmcgZm9yIHZhbHVlcyB3aXRoIGxlYWRpbmcgemVyb3NcbiAgICAgIGhleDogZmFsc2UsIC8vIERpc2FibGUgaGV4IG51bWJlciBwYXJzaW5nIC0gSW52YWxpZCBidWNrZXQgbmFtZVxuICAgICAgc2tpcExpa2U6IC9eWzAtOV0rJC8sIC8vIFNraXAgbnVtYmVyIHBhcnNpbmcgaWYgdGhlIHZhbHVlIGNvbnNpc3RzIGVudGlyZWx5IG9mIGRpZ2l0c1xuICAgIH0sXG4gICAgdGFnVmFsdWVQcm9jZXNzb3I6ICh0YWdOYW1lLCB0YWdWYWx1ZSA9ICcnKSA9PiB7XG4gICAgICAvLyBFbnN1cmUgdGhhdCB0aGUgTmFtZSB0YWcgaXMgYWx3YXlzIHRyZWF0ZWQgYXMgYSBzdHJpbmdcbiAgICAgIGlmICh0YWdOYW1lID09PSAnTmFtZScpIHtcbiAgICAgICAgcmV0dXJuIHRhZ1ZhbHVlLnRvU3RyaW5nKClcbiAgICAgIH1cbiAgICAgIHJldHVybiB0YWdWYWx1ZVxuICAgIH0sXG4gICAgaWdub3JlQXR0cmlidXRlczogZmFsc2UsIC8vIEVuc3VyZSB0aGF0IGFsbCBhdHRyaWJ1dGVzIGFyZSBwYXJzZWRcbiAgfSlcblxuICBjb25zdCBwYXJzZWRYbWxSZXMgPSBsaXN0QnVja2V0UmVzdWx0UGFyc2VyLnBhcnNlKHhtbClcblxuICBpZiAoIXBhcnNlZFhtbFJlcy5MaXN0QWxsTXlCdWNrZXRzUmVzdWx0KSB7XG4gICAgdGhyb3cgbmV3IGVycm9ycy5JbnZhbGlkWE1MRXJyb3IoJ01pc3NpbmcgdGFnOiBcIkxpc3RBbGxNeUJ1Y2tldHNSZXN1bHRcIicpXG4gIH1cblxuICBjb25zdCB7IExpc3RBbGxNeUJ1Y2tldHNSZXN1bHQ6IHsgQnVja2V0cyA9IHt9IH0gPSB7fSB9ID0gcGFyc2VkWG1sUmVzXG5cbiAgaWYgKEJ1Y2tldHMuQnVja2V0KSB7XG4gICAgcmVzdWx0ID0gdG9BcnJheShCdWNrZXRzLkJ1Y2tldCkubWFwKChidWNrZXQgPSB7fSkgPT4ge1xuICAgICAgY29uc3QgeyBOYW1lOiBidWNrZXROYW1lLCBDcmVhdGlvbkRhdGUgfSA9IGJ1Y2tldFxuICAgICAgY29uc3QgY3JlYXRpb25EYXRlID0gbmV3IERhdGUoQ3JlYXRpb25EYXRlKVxuXG4gICAgICByZXR1cm4geyBuYW1lOiBidWNrZXROYW1lLCBjcmVhdGlvbkRhdGUgfVxuICAgIH0pXG4gIH1cblxuICByZXR1cm4gcmVzdWx0XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBwYXJzZUluaXRpYXRlTXVsdGlwYXJ0KHhtbDogc3RyaW5nKTogc3RyaW5nIHtcbiAgbGV0IHhtbG9iaiA9IHBhcnNlWG1sKHhtbClcblxuICBpZiAoIXhtbG9iai5Jbml0aWF0ZU11bHRpcGFydFVwbG9hZFJlc3VsdCkge1xuICAgIHRocm93IG5ldyBlcnJvcnMuSW52YWxpZFhNTEVycm9yKCdNaXNzaW5nIHRhZzogXCJJbml0aWF0ZU11bHRpcGFydFVwbG9hZFJlc3VsdFwiJylcbiAgfVxuICB4bWxvYmogPSB4bWxvYmouSW5pdGlhdGVNdWx0aXBhcnRVcGxvYWRSZXN1bHRcblxuICBpZiAoeG1sb2JqLlVwbG9hZElkKSB7XG4gICAgcmV0dXJuIHhtbG9iai5VcGxvYWRJZFxuICB9XG4gIHRocm93IG5ldyBlcnJvcnMuSW52YWxpZFhNTEVycm9yKCdNaXNzaW5nIHRhZzogXCJVcGxvYWRJZFwiJylcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHBhcnNlUmVwbGljYXRpb25Db25maWcoeG1sOiBzdHJpbmcpOiBSZXBsaWNhdGlvbkNvbmZpZyB7XG4gIGNvbnN0IHhtbE9iaiA9IHBhcnNlWG1sKHhtbClcbiAgY29uc3QgeyBSb2xlLCBSdWxlIH0gPSB4bWxPYmouUmVwbGljYXRpb25Db25maWd1cmF0aW9uXG4gIHJldHVybiB7XG4gICAgUmVwbGljYXRpb25Db25maWd1cmF0aW9uOiB7XG4gICAgICByb2xlOiBSb2xlLFxuICAgICAgcnVsZXM6IHRvQXJyYXkoUnVsZSksXG4gICAgfSxcbiAgfVxufVxuXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VPYmplY3RMZWdhbEhvbGRDb25maWcoeG1sOiBzdHJpbmcpIHtcbiAgY29uc3QgeG1sT2JqID0gcGFyc2VYbWwoeG1sKVxuICByZXR1cm4geG1sT2JqLkxlZ2FsSG9sZFxufVxuXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VUYWdnaW5nKHhtbDogc3RyaW5nKSB7XG4gIGNvbnN0IHhtbE9iaiA9IHBhcnNlWG1sKHhtbClcbiAgbGV0IHJlc3VsdDogVGFnW10gPSBbXVxuICBpZiAoeG1sT2JqLlRhZ2dpbmcgJiYgeG1sT2JqLlRhZ2dpbmcuVGFnU2V0ICYmIHhtbE9iai5UYWdnaW5nLlRhZ1NldC5UYWcpIHtcbiAgICBjb25zdCB0YWdSZXN1bHQ6IFRhZyA9IHhtbE9iai5UYWdnaW5nLlRhZ1NldC5UYWdcbiAgICAvLyBpZiBpdCBpcyBhIHNpbmdsZSB0YWcgY29udmVydCBpbnRvIGFuIGFycmF5IHNvIHRoYXQgdGhlIHJldHVybiB2YWx1ZSBpcyBhbHdheXMgYW4gYXJyYXkuXG4gICAgaWYgKEFycmF5LmlzQXJyYXkodGFnUmVzdWx0KSkge1xuICAgICAgcmVzdWx0ID0gWy4uLnRhZ1Jlc3VsdF1cbiAgICB9IGVsc2Uge1xuICAgICAgcmVzdWx0LnB1c2godGFnUmVzdWx0KVxuICAgIH1cbiAgfVxuICByZXR1cm4gcmVzdWx0XG59XG5cbi8vIHBhcnNlIFhNTCByZXNwb25zZSB3aGVuIGEgbXVsdGlwYXJ0IHVwbG9hZCBpcyBjb21wbGV0ZWRcbmV4cG9ydCBmdW5jdGlvbiBwYXJzZUNvbXBsZXRlTXVsdGlwYXJ0KHhtbDogc3RyaW5nKSB7XG4gIGNvbnN0IHhtbG9iaiA9IHBhcnNlWG1sKHhtbCkuQ29tcGxldGVNdWx0aXBhcnRVcGxvYWRSZXN1bHRcbiAgaWYgKHhtbG9iai5Mb2NhdGlvbikge1xuICAgIGNvbnN0IGxvY2F0aW9uID0gdG9BcnJheSh4bWxvYmouTG9jYXRpb24pWzBdXG4gICAgY29uc3QgYnVja2V0ID0gdG9BcnJheSh4bWxvYmouQnVja2V0KVswXVxuICAgIGNvbnN0IGtleSA9IHhtbG9iai5LZXlcbiAgICBjb25zdCBldGFnID0geG1sb2JqLkVUYWcucmVwbGFjZSgvXlwiL2csICcnKVxuICAgICAgLnJlcGxhY2UoL1wiJC9nLCAnJylcbiAgICAgIC5yZXBsYWNlKC9eJnF1b3Q7L2csICcnKVxuICAgICAgLnJlcGxhY2UoLyZxdW90OyQvZywgJycpXG4gICAgICAucmVwbGFjZSgvXiYjMzQ7L2csICcnKVxuICAgICAgLnJlcGxhY2UoLyYjMzQ7JC9nLCAnJylcblxuICAgIHJldHVybiB7IGxvY2F0aW9uLCBidWNrZXQsIGtleSwgZXRhZyB9XG4gIH1cbiAgLy8gQ29tcGxldGUgTXVsdGlwYXJ0IGNhbiByZXR1cm4gWE1MIEVycm9yIGFmdGVyIGEgMjAwIE9LIHJlc3BvbnNlXG4gIGlmICh4bWxvYmouQ29kZSAmJiB4bWxvYmouTWVzc2FnZSkge1xuICAgIGNvbnN0IGVyckNvZGUgPSB0b0FycmF5KHhtbG9iai5Db2RlKVswXVxuICAgIGNvbnN0IGVyck1lc3NhZ2UgPSB0b0FycmF5KHhtbG9iai5NZXNzYWdlKVswXVxuICAgIHJldHVybiB7IGVyckNvZGUsIGVyck1lc3NhZ2UgfVxuICB9XG59XG5cbnR5cGUgVXBsb2FkSUQgPSBzdHJpbmdcblxuZXhwb3J0IHR5cGUgTGlzdE11bHRpcGFydFJlc3VsdCA9IHtcbiAgdXBsb2Fkczoge1xuICAgIGtleTogc3RyaW5nXG4gICAgdXBsb2FkSWQ6IFVwbG9hZElEXG4gICAgaW5pdGlhdG9yPzogeyBpZDogc3RyaW5nOyBkaXNwbGF5TmFtZTogc3RyaW5nIH1cbiAgICBvd25lcj86IHsgaWQ6IHN0cmluZzsgZGlzcGxheU5hbWU6IHN0cmluZyB9XG4gICAgc3RvcmFnZUNsYXNzOiB1bmtub3duXG4gICAgaW5pdGlhdGVkOiBEYXRlXG4gIH1bXVxuICBwcmVmaXhlczoge1xuICAgIHByZWZpeDogc3RyaW5nXG4gIH1bXVxuICBpc1RydW5jYXRlZDogYm9vbGVhblxuICBuZXh0S2V5TWFya2VyOiBzdHJpbmdcbiAgbmV4dFVwbG9hZElkTWFya2VyOiBzdHJpbmdcbn1cblxuLy8gcGFyc2UgWE1MIHJlc3BvbnNlIGZvciBsaXN0aW5nIGluLXByb2dyZXNzIG11bHRpcGFydCB1cGxvYWRzXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VMaXN0TXVsdGlwYXJ0KHhtbDogc3RyaW5nKTogTGlzdE11bHRpcGFydFJlc3VsdCB7XG4gIGNvbnN0IHJlc3VsdDogTGlzdE11bHRpcGFydFJlc3VsdCA9IHtcbiAgICBwcmVmaXhlczogW10sXG4gICAgdXBsb2FkczogW10sXG4gICAgaXNUcnVuY2F0ZWQ6IGZhbHNlLFxuICAgIG5leHRLZXlNYXJrZXI6ICcnLFxuICAgIG5leHRVcGxvYWRJZE1hcmtlcjogJycsXG4gIH1cblxuICBsZXQgeG1sb2JqID0gcGFyc2VYbWwoeG1sKVxuXG4gIGlmICgheG1sb2JqLkxpc3RNdWx0aXBhcnRVcGxvYWRzUmVzdWx0KSB7XG4gICAgdGhyb3cgbmV3IGVycm9ycy5JbnZhbGlkWE1MRXJyb3IoJ01pc3NpbmcgdGFnOiBcIkxpc3RNdWx0aXBhcnRVcGxvYWRzUmVzdWx0XCInKVxuICB9XG4gIHhtbG9iaiA9IHhtbG9iai5MaXN0TXVsdGlwYXJ0VXBsb2Fkc1Jlc3VsdFxuICBpZiAoeG1sb2JqLklzVHJ1bmNhdGVkKSB7XG4gICAgcmVzdWx0LmlzVHJ1bmNhdGVkID0geG1sb2JqLklzVHJ1bmNhdGVkXG4gIH1cbiAgaWYgKHhtbG9iai5OZXh0S2V5TWFya2VyKSB7XG4gICAgcmVzdWx0Lm5leHRLZXlNYXJrZXIgPSB4bWxvYmouTmV4dEtleU1hcmtlclxuICB9XG4gIGlmICh4bWxvYmouTmV4dFVwbG9hZElkTWFya2VyKSB7XG4gICAgcmVzdWx0Lm5leHRVcGxvYWRJZE1hcmtlciA9IHhtbG9iai5uZXh0VXBsb2FkSWRNYXJrZXIgfHwgJydcbiAgfVxuXG4gIGlmICh4bWxvYmouQ29tbW9uUHJlZml4ZXMpIHtcbiAgICB0b0FycmF5KHhtbG9iai5Db21tb25QcmVmaXhlcykuZm9yRWFjaCgocHJlZml4KSA9PiB7XG4gICAgICAvLyBAdHMtZXhwZWN0LWVycm9yIGluZGV4IGNoZWNrXG4gICAgICByZXN1bHQucHJlZml4ZXMucHVzaCh7IHByZWZpeDogc2FuaXRpemVPYmplY3RLZXkodG9BcnJheTxzdHJpbmc+KHByZWZpeC5QcmVmaXgpWzBdKSB9KVxuICAgIH0pXG4gIH1cblxuICBpZiAoeG1sb2JqLlVwbG9hZCkge1xuICAgIHRvQXJyYXkoeG1sb2JqLlVwbG9hZCkuZm9yRWFjaCgodXBsb2FkKSA9PiB7XG4gICAgICBjb25zdCB1cGxvYWRJdGVtOiBMaXN0TXVsdGlwYXJ0UmVzdWx0Wyd1cGxvYWRzJ11bbnVtYmVyXSA9IHtcbiAgICAgICAga2V5OiB1cGxvYWQuS2V5LFxuICAgICAgICB1cGxvYWRJZDogdXBsb2FkLlVwbG9hZElkLFxuICAgICAgICBzdG9yYWdlQ2xhc3M6IHVwbG9hZC5TdG9yYWdlQ2xhc3MsXG4gICAgICAgIGluaXRpYXRlZDogbmV3IERhdGUodXBsb2FkLkluaXRpYXRlZCksXG4gICAgICB9XG4gICAgICBpZiAodXBsb2FkLkluaXRpYXRvcikge1xuICAgICAgICB1cGxvYWRJdGVtLmluaXRpYXRvciA9IHsgaWQ6IHVwbG9hZC5Jbml0aWF0b3IuSUQsIGRpc3BsYXlOYW1lOiB1cGxvYWQuSW5pdGlhdG9yLkRpc3BsYXlOYW1lIH1cbiAgICAgIH1cbiAgICAgIGlmICh1cGxvYWQuT3duZXIpIHtcbiAgICAgICAgdXBsb2FkSXRlbS5vd25lciA9IHsgaWQ6IHVwbG9hZC5Pd25lci5JRCwgZGlzcGxheU5hbWU6IHVwbG9hZC5Pd25lci5EaXNwbGF5TmFtZSB9XG4gICAgICB9XG4gICAgICByZXN1bHQudXBsb2Fkcy5wdXNoKHVwbG9hZEl0ZW0pXG4gICAgfSlcbiAgfVxuICByZXR1cm4gcmVzdWx0XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBwYXJzZU9iamVjdExvY2tDb25maWcoeG1sOiBzdHJpbmcpOiBPYmplY3RMb2NrSW5mbyB7XG4gIGNvbnN0IHhtbE9iaiA9IHBhcnNlWG1sKHhtbClcbiAgbGV0IGxvY2tDb25maWdSZXN1bHQgPSB7fSBhcyBPYmplY3RMb2NrSW5mb1xuICBpZiAoeG1sT2JqLk9iamVjdExvY2tDb25maWd1cmF0aW9uKSB7XG4gICAgbG9ja0NvbmZpZ1Jlc3VsdCA9IHtcbiAgICAgIG9iamVjdExvY2tFbmFibGVkOiB4bWxPYmouT2JqZWN0TG9ja0NvbmZpZ3VyYXRpb24uT2JqZWN0TG9ja0VuYWJsZWQsXG4gICAgfSBhcyBPYmplY3RMb2NrSW5mb1xuICAgIGxldCByZXRlbnRpb25SZXNwXG4gICAgaWYgKFxuICAgICAgeG1sT2JqLk9iamVjdExvY2tDb25maWd1cmF0aW9uICYmXG4gICAgICB4bWxPYmouT2JqZWN0TG9ja0NvbmZpZ3VyYXRpb24uUnVsZSAmJlxuICAgICAgeG1sT2JqLk9iamVjdExvY2tDb25maWd1cmF0aW9uLlJ1bGUuRGVmYXVsdFJldGVudGlvblxuICAgICkge1xuICAgICAgcmV0ZW50aW9uUmVzcCA9IHhtbE9iai5PYmplY3RMb2NrQ29uZmlndXJhdGlvbi5SdWxlLkRlZmF1bHRSZXRlbnRpb24gfHwge31cbiAgICAgIGxvY2tDb25maWdSZXN1bHQubW9kZSA9IHJldGVudGlvblJlc3AuTW9kZVxuICAgIH1cbiAgICBpZiAocmV0ZW50aW9uUmVzcCkge1xuICAgICAgY29uc3QgaXNVbml0WWVhcnMgPSByZXRlbnRpb25SZXNwLlllYXJzXG4gICAgICBpZiAoaXNVbml0WWVhcnMpIHtcbiAgICAgICAgbG9ja0NvbmZpZ1Jlc3VsdC52YWxpZGl0eSA9IGlzVW5pdFllYXJzXG4gICAgICAgIGxvY2tDb25maWdSZXN1bHQudW5pdCA9IFJFVEVOVElPTl9WQUxJRElUWV9VTklUUy5ZRUFSU1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgbG9ja0NvbmZpZ1Jlc3VsdC52YWxpZGl0eSA9IHJldGVudGlvblJlc3AuRGF5c1xuICAgICAgICBsb2NrQ29uZmlnUmVzdWx0LnVuaXQgPSBSRVRFTlRJT05fVkFMSURJVFlfVU5JVFMuREFZU1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIHJldHVybiBsb2NrQ29uZmlnUmVzdWx0XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBwYXJzZUJ1Y2tldFZlcnNpb25pbmdDb25maWcoeG1sOiBzdHJpbmcpIHtcbiAgY29uc3QgeG1sT2JqID0gcGFyc2VYbWwoeG1sKVxuICByZXR1cm4geG1sT2JqLlZlcnNpb25pbmdDb25maWd1cmF0aW9uXG59XG5cbi8vIFVzZWQgb25seSBpbiBzZWxlY3RPYmplY3RDb250ZW50IEFQSS5cbi8vIGV4dHJhY3RIZWFkZXJUeXBlIGV4dHJhY3RzIHRoZSBmaXJzdCBoYWxmIG9mIHRoZSBoZWFkZXIgbWVzc2FnZSwgdGhlIGhlYWRlciB0eXBlLlxuZnVuY3Rpb24gZXh0cmFjdEhlYWRlclR5cGUoc3RyZWFtOiBzdHJlYW0uUmVhZGFibGUpOiBzdHJpbmcgfCB1bmRlZmluZWQge1xuICBjb25zdCBoZWFkZXJOYW1lTGVuID0gQnVmZmVyLmZyb20oc3RyZWFtLnJlYWQoMSkpLnJlYWRVSW50OCgpXG4gIGNvbnN0IGhlYWRlck5hbWVXaXRoU2VwYXJhdG9yID0gQnVmZmVyLmZyb20oc3RyZWFtLnJlYWQoaGVhZGVyTmFtZUxlbikpLnRvU3RyaW5nKClcbiAgY29uc3Qgc3BsaXRCeVNlcGFyYXRvciA9IChoZWFkZXJOYW1lV2l0aFNlcGFyYXRvciB8fCAnJykuc3BsaXQoJzonKVxuICByZXR1cm4gc3BsaXRCeVNlcGFyYXRvci5sZW5ndGggPj0gMSA/IHNwbGl0QnlTZXBhcmF0b3JbMV0gOiAnJ1xufVxuXG5mdW5jdGlvbiBleHRyYWN0SGVhZGVyVmFsdWUoc3RyZWFtOiBzdHJlYW0uUmVhZGFibGUpIHtcbiAgY29uc3QgYm9keUxlbiA9IEJ1ZmZlci5mcm9tKHN0cmVhbS5yZWFkKDIpKS5yZWFkVUludDE2QkUoKVxuICByZXR1cm4gQnVmZmVyLmZyb20oc3RyZWFtLnJlYWQoYm9keUxlbikpLnRvU3RyaW5nKClcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHBhcnNlU2VsZWN0T2JqZWN0Q29udGVudFJlc3BvbnNlKHJlczogQnVmZmVyKSB7XG4gIGNvbnN0IHNlbGVjdFJlc3VsdHMgPSBuZXcgU2VsZWN0UmVzdWx0cyh7fSkgLy8gd2lsbCBiZSByZXR1cm5lZFxuXG4gIGNvbnN0IHJlc3BvbnNlU3RyZWFtID0gcmVhZGFibGVTdHJlYW0ocmVzKSAvLyBjb252ZXJ0IGJ5dGUgYXJyYXkgdG8gYSByZWFkYWJsZSByZXNwb25zZVN0cmVhbVxuICAvLyBAdHMtaWdub3JlXG4gIHdoaWxlIChyZXNwb25zZVN0cmVhbS5fcmVhZGFibGVTdGF0ZS5sZW5ndGgpIHtcbiAgICAvLyBUb3AgbGV2ZWwgcmVzcG9uc2VTdHJlYW0gcmVhZCB0cmFja2VyLlxuICAgIGxldCBtc2dDcmNBY2N1bXVsYXRvciAvLyBhY2N1bXVsYXRlIGZyb20gc3RhcnQgb2YgdGhlIG1lc3NhZ2UgdGlsbCB0aGUgbWVzc2FnZSBjcmMgc3RhcnQuXG5cbiAgICBjb25zdCB0b3RhbEJ5dGVMZW5ndGhCdWZmZXIgPSBCdWZmZXIuZnJvbShyZXNwb25zZVN0cmVhbS5yZWFkKDQpKVxuICAgIG1zZ0NyY0FjY3VtdWxhdG9yID0gY3JjMzIodG90YWxCeXRlTGVuZ3RoQnVmZmVyKVxuXG4gICAgY29uc3QgaGVhZGVyQnl0ZXNCdWZmZXIgPSBCdWZmZXIuZnJvbShyZXNwb25zZVN0cmVhbS5yZWFkKDQpKVxuICAgIG1zZ0NyY0FjY3VtdWxhdG9yID0gY3JjMzIoaGVhZGVyQnl0ZXNCdWZmZXIsIG1zZ0NyY0FjY3VtdWxhdG9yKVxuXG4gICAgY29uc3QgY2FsY3VsYXRlZFByZWx1ZGVDcmMgPSBtc2dDcmNBY2N1bXVsYXRvci5yZWFkSW50MzJCRSgpIC8vIHVzZSBpdCB0byBjaGVjayBpZiBhbnkgQ1JDIG1pc21hdGNoIGluIGhlYWRlciBpdHNlbGYuXG5cbiAgICBjb25zdCBwcmVsdWRlQ3JjQnVmZmVyID0gQnVmZmVyLmZyb20ocmVzcG9uc2VTdHJlYW0ucmVhZCg0KSkgLy8gcmVhZCA0IGJ5dGVzICAgIGkuZSA0KzQgPTggKyA0ID0gMTIgKCBwcmVsdWRlICsgcHJlbHVkZSBjcmMpXG4gICAgbXNnQ3JjQWNjdW11bGF0b3IgPSBjcmMzMihwcmVsdWRlQ3JjQnVmZmVyLCBtc2dDcmNBY2N1bXVsYXRvcilcblxuICAgIGNvbnN0IHRvdGFsTXNnTGVuZ3RoID0gdG90YWxCeXRlTGVuZ3RoQnVmZmVyLnJlYWRJbnQzMkJFKClcbiAgICBjb25zdCBoZWFkZXJMZW5ndGggPSBoZWFkZXJCeXRlc0J1ZmZlci5yZWFkSW50MzJCRSgpXG4gICAgY29uc3QgcHJlbHVkZUNyY0J5dGVWYWx1ZSA9IHByZWx1ZGVDcmNCdWZmZXIucmVhZEludDMyQkUoKVxuXG4gICAgaWYgKHByZWx1ZGVDcmNCeXRlVmFsdWUgIT09IGNhbGN1bGF0ZWRQcmVsdWRlQ3JjKSB7XG4gICAgICAvLyBIYW5kbGUgSGVhZGVyIENSQyBtaXNtYXRjaCBFcnJvclxuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBgSGVhZGVyIENoZWNrc3VtIE1pc21hdGNoLCBQcmVsdWRlIENSQyBvZiAke3ByZWx1ZGVDcmNCeXRlVmFsdWV9IGRvZXMgbm90IGVxdWFsIGV4cGVjdGVkIENSQyBvZiAke2NhbGN1bGF0ZWRQcmVsdWRlQ3JjfWAsXG4gICAgICApXG4gICAgfVxuXG4gICAgY29uc3QgaGVhZGVyczogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7fVxuICAgIGlmIChoZWFkZXJMZW5ndGggPiAwKSB7XG4gICAgICBjb25zdCBoZWFkZXJCeXRlcyA9IEJ1ZmZlci5mcm9tKHJlc3BvbnNlU3RyZWFtLnJlYWQoaGVhZGVyTGVuZ3RoKSlcbiAgICAgIG1zZ0NyY0FjY3VtdWxhdG9yID0gY3JjMzIoaGVhZGVyQnl0ZXMsIG1zZ0NyY0FjY3VtdWxhdG9yKVxuICAgICAgY29uc3QgaGVhZGVyUmVhZGVyU3RyZWFtID0gcmVhZGFibGVTdHJlYW0oaGVhZGVyQnl0ZXMpXG4gICAgICAvLyBAdHMtaWdub3JlXG4gICAgICB3aGlsZSAoaGVhZGVyUmVhZGVyU3RyZWFtLl9yZWFkYWJsZVN0YXRlLmxlbmd0aCkge1xuICAgICAgICBjb25zdCBoZWFkZXJUeXBlTmFtZSA9IGV4dHJhY3RIZWFkZXJUeXBlKGhlYWRlclJlYWRlclN0cmVhbSlcbiAgICAgICAgaGVhZGVyUmVhZGVyU3RyZWFtLnJlYWQoMSkgLy8ganVzdCByZWFkIGFuZCBpZ25vcmUgaXQuXG4gICAgICAgIGlmIChoZWFkZXJUeXBlTmFtZSkge1xuICAgICAgICAgIGhlYWRlcnNbaGVhZGVyVHlwZU5hbWVdID0gZXh0cmFjdEhlYWRlclZhbHVlKGhlYWRlclJlYWRlclN0cmVhbSlcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cblxuICAgIGxldCBwYXlsb2FkU3RyZWFtXG4gICAgY29uc3QgcGF5TG9hZExlbmd0aCA9IHRvdGFsTXNnTGVuZ3RoIC0gaGVhZGVyTGVuZ3RoIC0gMTZcbiAgICBpZiAocGF5TG9hZExlbmd0aCA+IDApIHtcbiAgICAgIGNvbnN0IHBheUxvYWRCdWZmZXIgPSBCdWZmZXIuZnJvbShyZXNwb25zZVN0cmVhbS5yZWFkKHBheUxvYWRMZW5ndGgpKVxuICAgICAgbXNnQ3JjQWNjdW11bGF0b3IgPSBjcmMzMihwYXlMb2FkQnVmZmVyLCBtc2dDcmNBY2N1bXVsYXRvcilcbiAgICAgIC8vIHJlYWQgdGhlIGNoZWNrc3VtIGVhcmx5IGFuZCBkZXRlY3QgYW55IG1pc21hdGNoIHNvIHdlIGNhbiBhdm9pZCB1bm5lY2Vzc2FyeSBmdXJ0aGVyIHByb2Nlc3NpbmcuXG4gICAgICBjb25zdCBtZXNzYWdlQ3JjQnl0ZVZhbHVlID0gQnVmZmVyLmZyb20ocmVzcG9uc2VTdHJlYW0ucmVhZCg0KSkucmVhZEludDMyQkUoKVxuICAgICAgY29uc3QgY2FsY3VsYXRlZENyYyA9IG1zZ0NyY0FjY3VtdWxhdG9yLnJlYWRJbnQzMkJFKClcbiAgICAgIC8vIEhhbmRsZSBtZXNzYWdlIENSQyBFcnJvclxuICAgICAgaWYgKG1lc3NhZ2VDcmNCeXRlVmFsdWUgIT09IGNhbGN1bGF0ZWRDcmMpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAgIGBNZXNzYWdlIENoZWNrc3VtIE1pc21hdGNoLCBNZXNzYWdlIENSQyBvZiAke21lc3NhZ2VDcmNCeXRlVmFsdWV9IGRvZXMgbm90IGVxdWFsIGV4cGVjdGVkIENSQyBvZiAke2NhbGN1bGF0ZWRDcmN9YCxcbiAgICAgICAgKVxuICAgICAgfVxuICAgICAgcGF5bG9hZFN0cmVhbSA9IHJlYWRhYmxlU3RyZWFtKHBheUxvYWRCdWZmZXIpXG4gICAgfVxuICAgIGNvbnN0IG1lc3NhZ2VUeXBlID0gaGVhZGVyc1snbWVzc2FnZS10eXBlJ11cblxuICAgIHN3aXRjaCAobWVzc2FnZVR5cGUpIHtcbiAgICAgIGNhc2UgJ2Vycm9yJzoge1xuICAgICAgICBjb25zdCBlcnJvck1lc3NhZ2UgPSBoZWFkZXJzWydlcnJvci1jb2RlJ10gKyAnOlwiJyArIGhlYWRlcnNbJ2Vycm9yLW1lc3NhZ2UnXSArICdcIidcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGVycm9yTWVzc2FnZSlcbiAgICAgIH1cbiAgICAgIGNhc2UgJ2V2ZW50Jzoge1xuICAgICAgICBjb25zdCBjb250ZW50VHlwZSA9IGhlYWRlcnNbJ2NvbnRlbnQtdHlwZSddXG4gICAgICAgIGNvbnN0IGV2ZW50VHlwZSA9IGhlYWRlcnNbJ2V2ZW50LXR5cGUnXVxuXG4gICAgICAgIHN3aXRjaCAoZXZlbnRUeXBlKSB7XG4gICAgICAgICAgY2FzZSAnRW5kJzoge1xuICAgICAgICAgICAgc2VsZWN0UmVzdWx0cy5zZXRSZXNwb25zZShyZXMpXG4gICAgICAgICAgICByZXR1cm4gc2VsZWN0UmVzdWx0c1xuICAgICAgICAgIH1cblxuICAgICAgICAgIGNhc2UgJ1JlY29yZHMnOiB7XG4gICAgICAgICAgICBjb25zdCByZWFkRGF0YSA9IHBheWxvYWRTdHJlYW0/LnJlYWQocGF5TG9hZExlbmd0aClcbiAgICAgICAgICAgIHNlbGVjdFJlc3VsdHMuc2V0UmVjb3JkcyhyZWFkRGF0YSlcbiAgICAgICAgICAgIGJyZWFrXG4gICAgICAgICAgfVxuXG4gICAgICAgICAgY2FzZSAnUHJvZ3Jlc3MnOlxuICAgICAgICAgICAge1xuICAgICAgICAgICAgICBzd2l0Y2ggKGNvbnRlbnRUeXBlKSB7XG4gICAgICAgICAgICAgICAgY2FzZSAndGV4dC94bWwnOiB7XG4gICAgICAgICAgICAgICAgICBjb25zdCBwcm9ncmVzc0RhdGEgPSBwYXlsb2FkU3RyZWFtPy5yZWFkKHBheUxvYWRMZW5ndGgpXG4gICAgICAgICAgICAgICAgICBzZWxlY3RSZXN1bHRzLnNldFByb2dyZXNzKHByb2dyZXNzRGF0YS50b1N0cmluZygpKVxuICAgICAgICAgICAgICAgICAgYnJlYWtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgZGVmYXVsdDoge1xuICAgICAgICAgICAgICAgICAgY29uc3QgZXJyb3JNZXNzYWdlID0gYFVuZXhwZWN0ZWQgY29udGVudC10eXBlICR7Y29udGVudFR5cGV9IHNlbnQgZm9yIGV2ZW50LXR5cGUgUHJvZ3Jlc3NgXG4gICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoZXJyb3JNZXNzYWdlKVxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICAgICAgYnJlYWtcbiAgICAgICAgICBjYXNlICdTdGF0cyc6XG4gICAgICAgICAgICB7XG4gICAgICAgICAgICAgIHN3aXRjaCAoY29udGVudFR5cGUpIHtcbiAgICAgICAgICAgICAgICBjYXNlICd0ZXh0L3htbCc6IHtcbiAgICAgICAgICAgICAgICAgIGNvbnN0IHN0YXRzRGF0YSA9IHBheWxvYWRTdHJlYW0/LnJlYWQocGF5TG9hZExlbmd0aClcbiAgICAgICAgICAgICAgICAgIHNlbGVjdFJlc3VsdHMuc2V0U3RhdHMoc3RhdHNEYXRhLnRvU3RyaW5nKCkpXG4gICAgICAgICAgICAgICAgICBicmVha1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBkZWZhdWx0OiB7XG4gICAgICAgICAgICAgICAgICBjb25zdCBlcnJvck1lc3NhZ2UgPSBgVW5leHBlY3RlZCBjb250ZW50LXR5cGUgJHtjb250ZW50VHlwZX0gc2VudCBmb3IgZXZlbnQtdHlwZSBTdGF0c2BcbiAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihlcnJvck1lc3NhZ2UpXG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBicmVha1xuICAgICAgICAgIGRlZmF1bHQ6IHtcbiAgICAgICAgICAgIC8vIENvbnRpbnVhdGlvbiBtZXNzYWdlOiBOb3Qgc3VyZSBpZiBpdCBpcyBzdXBwb3J0ZWQuIGRpZCBub3QgZmluZCBhIHJlZmVyZW5jZSBvciBhbnkgbWVzc2FnZSBpbiByZXNwb25zZS5cbiAgICAgICAgICAgIC8vIEl0IGRvZXMgbm90IGhhdmUgYSBwYXlsb2FkLlxuICAgICAgICAgICAgY29uc3Qgd2FybmluZ01lc3NhZ2UgPSBgVW4gaW1wbGVtZW50ZWQgZXZlbnQgZGV0ZWN0ZWQgICR7bWVzc2FnZVR5cGV9LmBcbiAgICAgICAgICAgIC8vIGVzbGludC1kaXNhYmxlLW5leHQtbGluZSBuby1jb25zb2xlXG4gICAgICAgICAgICBjb25zb2xlLndhcm4od2FybmluZ01lc3NhZ2UpXG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuICB9XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBwYXJzZUxpZmVjeWNsZUNvbmZpZyh4bWw6IHN0cmluZykge1xuICBjb25zdCB4bWxPYmogPSBwYXJzZVhtbCh4bWwpXG4gIHJldHVybiB4bWxPYmouTGlmZWN5Y2xlQ29uZmlndXJhdGlvblxufVxuXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VCdWNrZXRFbmNyeXB0aW9uQ29uZmlnKHhtbDogc3RyaW5nKSB7XG4gIHJldHVybiBwYXJzZVhtbCh4bWwpXG59XG5cbmV4cG9ydCBmdW5jdGlvbiBwYXJzZU9iamVjdFJldGVudGlvbkNvbmZpZyh4bWw6IHN0cmluZykge1xuICBjb25zdCB4bWxPYmogPSBwYXJzZVhtbCh4bWwpXG4gIGNvbnN0IHJldGVudGlvbkNvbmZpZyA9IHhtbE9iai5SZXRlbnRpb25cbiAgcmV0dXJuIHtcbiAgICBtb2RlOiByZXRlbnRpb25Db25maWcuTW9kZSxcbiAgICByZXRhaW5VbnRpbERhdGU6IHJldGVudGlvbkNvbmZpZy5SZXRhaW5VbnRpbERhdGUsXG4gIH1cbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHJlbW92ZU9iamVjdHNQYXJzZXIoeG1sOiBzdHJpbmcpIHtcbiAgY29uc3QgeG1sT2JqID0gcGFyc2VYbWwoeG1sKVxuICBpZiAoeG1sT2JqLkRlbGV0ZVJlc3VsdCAmJiB4bWxPYmouRGVsZXRlUmVzdWx0LkVycm9yKSB7XG4gICAgLy8gcmV0dXJuIGVycm9ycyBhcyBhcnJheSBhbHdheXMuIGFzIHRoZSByZXNwb25zZSBpcyBvYmplY3QgaW4gY2FzZSBvZiBzaW5nbGUgb2JqZWN0IHBhc3NlZCBpbiByZW1vdmVPYmplY3RzXG4gICAgcmV0dXJuIHRvQXJyYXkoeG1sT2JqLkRlbGV0ZVJlc3VsdC5FcnJvcilcbiAgfVxuICByZXR1cm4gW11cbn1cblxuLy8gcGFyc2UgWE1MIHJlc3BvbnNlIGZvciBjb3B5IG9iamVjdFxuZXhwb3J0IGZ1bmN0aW9uIHBhcnNlQ29weU9iamVjdCh4bWw6IHN0cmluZyk6IENvcHlPYmplY3RSZXN1bHRWMSB7XG4gIGNvbnN0IHJlc3VsdDogQ29weU9iamVjdFJlc3VsdFYxID0ge1xuICAgIGV0YWc6ICcnLFxuICAgIGxhc3RNb2RpZmllZDogJycsXG4gIH1cblxuICBsZXQgeG1sb2JqID0gcGFyc2VYbWwoeG1sKVxuICBpZiAoIXhtbG9iai5Db3B5T2JqZWN0UmVzdWx0KSB7XG4gICAgdGhyb3cgbmV3IGVycm9ycy5JbnZhbGlkWE1MRXJyb3IoJ01pc3NpbmcgdGFnOiBcIkNvcHlPYmplY3RSZXN1bHRcIicpXG4gIH1cbiAgeG1sb2JqID0geG1sb2JqLkNvcHlPYmplY3RSZXN1bHRcbiAgaWYgKHhtbG9iai5FVGFnKSB7XG4gICAgcmVzdWx0LmV0YWcgPSB4bWxvYmouRVRhZy5yZXBsYWNlKC9eXCIvZywgJycpXG4gICAgICAucmVwbGFjZSgvXCIkL2csICcnKVxuICAgICAgLnJlcGxhY2UoL14mcXVvdDsvZywgJycpXG4gICAgICAucmVwbGFjZSgvJnF1b3Q7JC9nLCAnJylcbiAgICAgIC5yZXBsYWNlKC9eJiMzNDsvZywgJycpXG4gICAgICAucmVwbGFjZSgvJiMzNDskL2csICcnKVxuICB9XG4gIGlmICh4bWxvYmouTGFzdE1vZGlmaWVkKSB7XG4gICAgcmVzdWx0Lmxhc3RNb2RpZmllZCA9IG5ldyBEYXRlKHhtbG9iai5MYXN0TW9kaWZpZWQpXG4gIH1cblxuICByZXR1cm4gcmVzdWx0XG59XG5cbmNvbnN0IGZvcm1hdE9iakluZm8gPSAoY29udGVudDogT2JqZWN0Um93RW50cnksIG9wdHM6IHsgSXNEZWxldGVNYXJrZXI/OiBib29sZWFuIH0gPSB7fSkgPT4ge1xuICBjb25zdCB7IEtleSwgTGFzdE1vZGlmaWVkLCBFVGFnLCBTaXplLCBWZXJzaW9uSWQsIElzTGF0ZXN0IH0gPSBjb250ZW50XG5cbiAgaWYgKCFpc09iamVjdChvcHRzKSkge1xuICAgIG9wdHMgPSB7fVxuICB9XG5cbiAgY29uc3QgbmFtZSA9IHNhbml0aXplT2JqZWN0S2V5KHRvQXJyYXkoS2V5KVswXSB8fCAnJylcbiAgY29uc3QgbGFzdE1vZGlmaWVkID0gTGFzdE1vZGlmaWVkID8gbmV3IERhdGUodG9BcnJheShMYXN0TW9kaWZpZWQpWzBdIHx8ICcnKSA6IHVuZGVmaW5lZFxuICBjb25zdCBldGFnID0gc2FuaXRpemVFVGFnKHRvQXJyYXkoRVRhZylbMF0gfHwgJycpXG4gIGNvbnN0IHNpemUgPSBzYW5pdGl6ZVNpemUoU2l6ZSB8fCAnJylcblxuICByZXR1cm4ge1xuICAgIG5hbWUsXG4gICAgbGFzdE1vZGlmaWVkLFxuICAgIGV0YWcsXG4gICAgc2l6ZSxcbiAgICB2ZXJzaW9uSWQ6IFZlcnNpb25JZCxcbiAgICBpc0xhdGVzdDogSXNMYXRlc3QsXG4gICAgaXNEZWxldGVNYXJrZXI6IG9wdHMuSXNEZWxldGVNYXJrZXIgPyBvcHRzLklzRGVsZXRlTWFya2VyIDogZmFsc2UsXG4gIH1cbn1cblxuLy8gcGFyc2UgWE1MIHJlc3BvbnNlIGZvciBsaXN0IG9iamVjdHMgaW4gYSBidWNrZXRcbmV4cG9ydCBmdW5jdGlvbiBwYXJzZUxpc3RPYmplY3RzKHhtbDogc3RyaW5nKSB7XG4gIGNvbnN0IHJlc3VsdDoge1xuICAgIG9iamVjdHM6IE9iamVjdEluZm9bXVxuICAgIGlzVHJ1bmNhdGVkPzogYm9vbGVhblxuICAgIG5leHRNYXJrZXI/OiBzdHJpbmdcbiAgICB2ZXJzaW9uSWRNYXJrZXI/OiBzdHJpbmdcbiAgICBrZXlNYXJrZXI/OiBzdHJpbmdcbiAgfSA9IHtcbiAgICBvYmplY3RzOiBbXSxcbiAgICBpc1RydW5jYXRlZDogZmFsc2UsXG4gICAgbmV4dE1hcmtlcjogdW5kZWZpbmVkLFxuICAgIHZlcnNpb25JZE1hcmtlcjogdW5kZWZpbmVkLFxuICAgIGtleU1hcmtlcjogdW5kZWZpbmVkLFxuICB9XG4gIGxldCBpc1RydW5jYXRlZCA9IGZhbHNlXG4gIGxldCBuZXh0TWFya2VyXG4gIGNvbnN0IHhtbG9iaiA9IGZ4cFdpdGhvdXROdW1QYXJzZXIucGFyc2UoeG1sKVxuXG4gIGNvbnN0IHBhcnNlQ29tbW9uUHJlZml4ZXNFbnRpdHkgPSAoY29tbW9uUHJlZml4RW50cnk6IENvbW1vblByZWZpeFtdKSA9PiB7XG4gICAgaWYgKGNvbW1vblByZWZpeEVudHJ5KSB7XG4gICAgICB0b0FycmF5KGNvbW1vblByZWZpeEVudHJ5KS5mb3JFYWNoKChjb21tb25QcmVmaXgpID0+IHtcbiAgICAgICAgcmVzdWx0Lm9iamVjdHMucHVzaCh7IHByZWZpeDogc2FuaXRpemVPYmplY3RLZXkodG9BcnJheShjb21tb25QcmVmaXguUHJlZml4KVswXSB8fCAnJyksIHNpemU6IDAgfSlcbiAgICAgIH0pXG4gICAgfVxuICB9XG5cbiAgY29uc3QgbGlzdEJ1Y2tldFJlc3VsdDogTGlzdEJ1Y2tldFJlc3VsdFYxID0geG1sb2JqLkxpc3RCdWNrZXRSZXN1bHRcbiAgY29uc3QgbGlzdFZlcnNpb25zUmVzdWx0OiBMaXN0QnVja2V0UmVzdWx0VjEgPSB4bWxvYmouTGlzdFZlcnNpb25zUmVzdWx0XG5cbiAgaWYgKGxpc3RCdWNrZXRSZXN1bHQpIHtcbiAgICBpZiAobGlzdEJ1Y2tldFJlc3VsdC5Jc1RydW5jYXRlZCkge1xuICAgICAgaXNUcnVuY2F0ZWQgPSBsaXN0QnVja2V0UmVzdWx0LklzVHJ1bmNhdGVkXG4gICAgfVxuICAgIGlmIChsaXN0QnVja2V0UmVzdWx0LkNvbnRlbnRzKSB7XG4gICAgICB0b0FycmF5KGxpc3RCdWNrZXRSZXN1bHQuQ29udGVudHMpLmZvckVhY2goKGNvbnRlbnQpID0+IHtcbiAgICAgICAgY29uc3QgbmFtZSA9IHNhbml0aXplT2JqZWN0S2V5KHRvQXJyYXkoY29udGVudC5LZXkpWzBdIHx8ICcnKVxuICAgICAgICBjb25zdCBsYXN0TW9kaWZpZWQgPSBuZXcgRGF0ZSh0b0FycmF5KGNvbnRlbnQuTGFzdE1vZGlmaWVkKVswXSB8fCAnJylcbiAgICAgICAgY29uc3QgZXRhZyA9IHNhbml0aXplRVRhZyh0b0FycmF5KGNvbnRlbnQuRVRhZylbMF0gfHwgJycpXG4gICAgICAgIGNvbnN0IHNpemUgPSBzYW5pdGl6ZVNpemUoY29udGVudC5TaXplIHx8ICcnKVxuICAgICAgICByZXN1bHQub2JqZWN0cy5wdXNoKHsgbmFtZSwgbGFzdE1vZGlmaWVkLCBldGFnLCBzaXplIH0pXG4gICAgICB9KVxuICAgIH1cblxuICAgIGlmIChsaXN0QnVja2V0UmVzdWx0Lk1hcmtlcikge1xuICAgICAgbmV4dE1hcmtlciA9IGxpc3RCdWNrZXRSZXN1bHQuTWFya2VyXG4gICAgfVxuICAgIGlmIChsaXN0QnVja2V0UmVzdWx0Lk5leHRNYXJrZXIpIHtcbiAgICAgIG5leHRNYXJrZXIgPSBsaXN0QnVja2V0UmVzdWx0Lk5leHRNYXJrZXJcbiAgICB9IGVsc2UgaWYgKGlzVHJ1bmNhdGVkICYmIHJlc3VsdC5vYmplY3RzLmxlbmd0aCA+IDApIHtcbiAgICAgIG5leHRNYXJrZXIgPSByZXN1bHQub2JqZWN0c1tyZXN1bHQub2JqZWN0cy5sZW5ndGggLSAxXT8ubmFtZVxuICAgIH1cbiAgICBpZiAobGlzdEJ1Y2tldFJlc3VsdC5Db21tb25QcmVmaXhlcykge1xuICAgICAgcGFyc2VDb21tb25QcmVmaXhlc0VudGl0eShsaXN0QnVja2V0UmVzdWx0LkNvbW1vblByZWZpeGVzKVxuICAgIH1cbiAgfVxuXG4gIGlmIChsaXN0VmVyc2lvbnNSZXN1bHQpIHtcbiAgICBpZiAobGlzdFZlcnNpb25zUmVzdWx0LklzVHJ1bmNhdGVkKSB7XG4gICAgICBpc1RydW5jYXRlZCA9IGxpc3RWZXJzaW9uc1Jlc3VsdC5Jc1RydW5jYXRlZFxuICAgIH1cblxuICAgIGlmIChsaXN0VmVyc2lvbnNSZXN1bHQuVmVyc2lvbikge1xuICAgICAgdG9BcnJheShsaXN0VmVyc2lvbnNSZXN1bHQuVmVyc2lvbikuZm9yRWFjaCgoY29udGVudCkgPT4ge1xuICAgICAgICByZXN1bHQub2JqZWN0cy5wdXNoKGZvcm1hdE9iakluZm8oY29udGVudCkpXG4gICAgICB9KVxuICAgIH1cbiAgICBpZiAobGlzdFZlcnNpb25zUmVzdWx0LkRlbGV0ZU1hcmtlcikge1xuICAgICAgdG9BcnJheShsaXN0VmVyc2lvbnNSZXN1bHQuRGVsZXRlTWFya2VyKS5mb3JFYWNoKChjb250ZW50KSA9PiB7XG4gICAgICAgIHJlc3VsdC5vYmplY3RzLnB1c2goZm9ybWF0T2JqSW5mbyhjb250ZW50LCB7IElzRGVsZXRlTWFya2VyOiB0cnVlIH0pKVxuICAgICAgfSlcbiAgICB9XG5cbiAgICBpZiAobGlzdFZlcnNpb25zUmVzdWx0Lk5leHRLZXlNYXJrZXIpIHtcbiAgICAgIHJlc3VsdC5rZXlNYXJrZXIgPSBsaXN0VmVyc2lvbnNSZXN1bHQuTmV4dEtleU1hcmtlclxuICAgIH1cbiAgICBpZiAobGlzdFZlcnNpb25zUmVzdWx0Lk5leHRWZXJzaW9uSWRNYXJrZXIpIHtcbiAgICAgIHJlc3VsdC52ZXJzaW9uSWRNYXJrZXIgPSBsaXN0VmVyc2lvbnNSZXN1bHQuTmV4dFZlcnNpb25JZE1hcmtlclxuICAgIH1cbiAgICBpZiAobGlzdFZlcnNpb25zUmVzdWx0LkNvbW1vblByZWZpeGVzKSB7XG4gICAgICBwYXJzZUNvbW1vblByZWZpeGVzRW50aXR5KGxpc3RWZXJzaW9uc1Jlc3VsdC5Db21tb25QcmVmaXhlcylcbiAgICB9XG4gIH1cblxuICByZXN1bHQuaXNUcnVuY2F0ZWQgPSBpc1RydW5jYXRlZFxuICBpZiAoaXNUcnVuY2F0ZWQpIHtcbiAgICByZXN1bHQubmV4dE1hcmtlciA9IG5leHRNYXJrZXJcbiAgfVxuICByZXR1cm4gcmVzdWx0XG59XG5cbmV4cG9ydCBmdW5jdGlvbiB1cGxvYWRQYXJ0UGFyc2VyKHhtbDogc3RyaW5nKSB7XG4gIGNvbnN0IHhtbE9iaiA9IHBhcnNlWG1sKHhtbClcbiAgY29uc3QgcmVzcEVsID0geG1sT2JqLkNvcHlQYXJ0UmVzdWx0XG4gIHJldHVybiByZXNwRWxcbn1cbiJdLCJtYXBwaW5ncyI6Ijs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBR0EsSUFBQUEsVUFBQSxHQUFBQyxPQUFBO0FBQ0EsSUFBQUMsY0FBQSxHQUFBRCxPQUFBO0FBRUEsSUFBQUUsTUFBQSxHQUFBQyx1QkFBQSxDQUFBSCxPQUFBO0FBQ0EsSUFBQUksUUFBQSxHQUFBSixPQUFBO0FBQ0EsSUFBQUssT0FBQSxHQUFBTCxPQUFBO0FBQ0EsSUFBQU0sU0FBQSxHQUFBTixPQUFBO0FBY0EsSUFBQU8sS0FBQSxHQUFBUCxPQUFBO0FBQW9ELFNBQUFRLHlCQUFBQyxXQUFBLGVBQUFDLE9BQUEsa0NBQUFDLGlCQUFBLE9BQUFELE9BQUEsUUFBQUUsZ0JBQUEsT0FBQUYsT0FBQSxZQUFBRix3QkFBQSxZQUFBQSxDQUFBQyxXQUFBLFdBQUFBLFdBQUEsR0FBQUcsZ0JBQUEsR0FBQUQsaUJBQUEsS0FBQUYsV0FBQTtBQUFBLFNBQUFOLHdCQUFBVSxHQUFBLEVBQUFKLFdBQUEsU0FBQUEsV0FBQSxJQUFBSSxHQUFBLElBQUFBLEdBQUEsQ0FBQUMsVUFBQSxXQUFBRCxHQUFBLFFBQUFBLEdBQUEsb0JBQUFBLEdBQUEsd0JBQUFBLEdBQUEsNEJBQUFFLE9BQUEsRUFBQUYsR0FBQSxVQUFBRyxLQUFBLEdBQUFSLHdCQUFBLENBQUFDLFdBQUEsT0FBQU8sS0FBQSxJ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