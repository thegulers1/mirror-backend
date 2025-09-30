import crc32 from 'buffer-crc32';
import { XMLParser } from 'fast-xml-parser';
import * as errors from "../errors.mjs";
import { SelectResults } from "../helpers.mjs";
import { isObject, parseXml, readableStream, sanitizeETag, sanitizeObjectKey, sanitizeSize, toArray } from "./helper.mjs";
import { readAsString } from "./response.mjs";
import { RETENTION_VALIDITY_UNITS } from "./type.mjs";

// parse XML response for bucket region
export function parseBucketRegion(xml) {
  // return region information
  return parseXml(xml).LocationConstraint;
}
const fxp = new XMLParser();
const fxpWithoutNumParser = new XMLParser({
  // @ts-ignore
  numberParseOptions: {
    skipLike: /./
  }
});

// Parse XML and return information as Javascript types
// parse error XML response
export function parseError(xml, headerInfo) {
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
export async function parseResponseError(response) {
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
  const xmlString = await readAsString(response);
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
export function parseListObjectsV2WithMetadata(xml) {
  const result = {
    objects: [],
    isTruncated: false,
    nextContinuationToken: ''
  };
  let xmlobj = parseXml(xml);
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
    toArray(xmlobj.Contents).forEach(content => {
      const name = sanitizeObjectKey(content.Key);
      const lastModified = new Date(content.LastModified);
      const etag = sanitizeETag(content.ETag);
      const size = content.Size;
      let tags = {};
      if (content.UserTags != null) {
        toArray(content.UserTags.split('&')).forEach(tag => {
          const [key, value] = tag.split('=');
          tags[key] = value;
        });
      } else {
        tags = {};
      }
      let metadata;
      if (content.UserMetadata != null) {
        metadata = toArray(content.UserMetadata)[0];
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
    toArray(xmlobj.CommonPrefixes).forEach(commonPrefix => {
      result.objects.push({
        prefix: sanitizeObjectKey(toArray(commonPrefix.Prefix)[0]),
        size: 0
      });
    });
  }
  return result;
}
// parse XML response for list parts of an in progress multipart upload
export function parseListParts(xml) {
  let xmlobj = parseXml(xml);
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
    result.marker = toArray(xmlobj.NextPartNumberMarker)[0] || '';
  }
  if (xmlobj.Part) {
    toArray(xmlobj.Part).forEach(p => {
      const part = parseInt(toArray(p.PartNumber)[0], 10);
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
export function parseListBucket(xml) {
  let result = [];
  const listBucketResultParser = new XMLParser({
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
    result = toArray(Buckets.Bucket).map((bucket = {}) => {
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
export function parseInitiateMultipart(xml) {
  let xmlobj = parseXml(xml);
  if (!xmlobj.InitiateMultipartUploadResult) {
    throw new errors.InvalidXMLError('Missing tag: "InitiateMultipartUploadResult"');
  }
  xmlobj = xmlobj.InitiateMultipartUploadResult;
  if (xmlobj.UploadId) {
    return xmlobj.UploadId;
  }
  throw new errors.InvalidXMLError('Missing tag: "UploadId"');
}
export function parseReplicationConfig(xml) {
  const xmlObj = parseXml(xml);
  const {
    Role,
    Rule
  } = xmlObj.ReplicationConfiguration;
  return {
    ReplicationConfiguration: {
      role: Role,
      rules: toArray(Rule)
    }
  };
}
export function parseObjectLegalHoldConfig(xml) {
  const xmlObj = parseXml(xml);
  return xmlObj.LegalHold;
}
export function parseTagging(xml) {
  const xmlObj = parseXml(xml);
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
export function parseCompleteMultipart(xml) {
  const xmlobj = parseXml(xml).CompleteMultipartUploadResult;
  if (xmlobj.Location) {
    const location = toArray(xmlobj.Location)[0];
    const bucket = toArray(xmlobj.Bucket)[0];
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
    const errCode = toArray(xmlobj.Code)[0];
    const errMessage = toArray(xmlobj.Message)[0];
    return {
      errCode,
      errMessage
    };
  }
}
// parse XML response for listing in-progress multipart uploads
export function parseListMultipart(xml) {
  const result = {
    prefixes: [],
    uploads: [],
    isTruncated: false,
    nextKeyMarker: '',
    nextUploadIdMarker: ''
  };
  let xmlobj = parseXml(xml);
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
    toArray(xmlobj.CommonPrefixes).forEach(prefix => {
      // @ts-expect-error index check
      result.prefixes.push({
        prefix: sanitizeObjectKey(toArray(prefix.Prefix)[0])
      });
    });
  }
  if (xmlobj.Upload) {
    toArray(xmlobj.Upload).forEach(upload => {
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
export function parseObjectLockConfig(xml) {
  const xmlObj = parseXml(xml);
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
        lockConfigResult.unit = RETENTION_VALIDITY_UNITS.YEARS;
      } else {
        lockConfigResult.validity = retentionResp.Days;
        lockConfigResult.unit = RETENTION_VALIDITY_UNITS.DAYS;
      }
    }
  }
  return lockConfigResult;
}
export function parseBucketVersioningConfig(xml) {
  const xmlObj = parseXml(xml);
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
export function parseSelectObjectContentResponse(res) {
  const selectResults = new SelectResults({}); // will be returned

  const responseStream = readableStream(res); // convert byte array to a readable responseStream
  // @ts-ignore
  while (responseStream._readableState.length) {
    // Top level responseStream read tracker.
    let msgCrcAccumulator; // accumulate from start of the message till the message crc start.

    const totalByteLengthBuffer = Buffer.from(responseStream.read(4));
    msgCrcAccumulator = crc32(totalByteLengthBuffer);
    const headerBytesBuffer = Buffer.from(responseStream.read(4));
    msgCrcAccumulator = crc32(headerBytesBuffer, msgCrcAccumulator);
    const calculatedPreludeCrc = msgCrcAccumulator.readInt32BE(); // use it to check if any CRC mismatch in header itself.

    const preludeCrcBuffer = Buffer.from(responseStream.read(4)); // read 4 bytes    i.e 4+4 =8 + 4 = 12 ( prelude + prelude crc)
    msgCrcAccumulator = crc32(preludeCrcBuffer, msgCrcAccumulator);
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
      msgCrcAccumulator = crc32(headerBytes, msgCrcAccumulator);
      const headerReaderStream = readableStream(headerBytes);
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
      msgCrcAccumulator = crc32(payLoadBuffer, msgCrcAccumulator);
      // read the checksum early and detect any mismatch so we can avoid unnecessary further processing.
      const messageCrcByteValue = Buffer.from(responseStream.read(4)).readInt32BE();
      const calculatedCrc = msgCrcAccumulator.readInt32BE();
      // Handle message CRC Error
      if (messageCrcByteValue !== calculatedCrc) {
        throw new Error(`Message Checksum Mismatch, Message CRC of ${messageCrcByteValue} does not equal expected CRC of ${calculatedCrc}`);
      }
      payloadStream = readableStream(payLoadBuffer);
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
export function parseLifecycleConfig(xml) {
  const xmlObj = parseXml(xml);
  return xmlObj.LifecycleConfiguration;
}
export function parseBucketEncryptionConfig(xml) {
  return parseXml(xml);
}
export function parseObjectRetentionConfig(xml) {
  const xmlObj = parseXml(xml);
  const retentionConfig = xmlObj.Retention;
  return {
    mode: retentionConfig.Mode,
    retainUntilDate: retentionConfig.RetainUntilDate
  };
}
export function removeObjectsParser(xml) {
  const xmlObj = parseXml(xml);
  if (xmlObj.DeleteResult && xmlObj.DeleteResult.Error) {
    // return errors as array always. as the response is object in case of single object passed in removeObjects
    return toArray(xmlObj.DeleteResult.Error);
  }
  return [];
}

// parse XML response for copy object
export function parseCopyObject(xml) {
  const result = {
    etag: '',
    lastModified: ''
  };
  let xmlobj = parseXml(xml);
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
  if (!isObject(opts)) {
    opts = {};
  }
  const name = sanitizeObjectKey(toArray(Key)[0] || '');
  const lastModified = LastModified ? new Date(toArray(LastModified)[0] || '') : undefined;
  const etag = sanitizeETag(toArray(ETag)[0] || '');
  const size = sanitizeSize(Size || '');
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
export function parseListObjects(xml) {
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
      toArray(commonPrefixEntry).forEach(commonPrefix => {
        result.objects.push({
          prefix: sanitizeObjectKey(toArray(commonPrefix.Prefix)[0] || ''),
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
      toArray(listBucketResult.Contents).forEach(content => {
        const name = sanitizeObjectKey(toArray(content.Key)[0] || '');
        const lastModified = new Date(toArray(content.LastModified)[0] || '');
        const etag = sanitizeETag(toArray(content.ETag)[0] || '');
        const size = sanitizeSize(content.Size || '');
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
      toArray(listVersionsResult.Version).forEach(content => {
        result.objects.push(formatObjInfo(content));
      });
    }
    if (listVersionsResult.DeleteMarker) {
      toArray(listVersionsResult.DeleteMarker).forEach(content => {
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
export function uploadPartParser(xml) {
  const xmlObj = parseXml(xml);
  const respEl = xmlObj.CopyPartResult;
  return respEl;
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJjcmMzMiIsIlhNTFBhcnNlciIsImVycm9ycyIsIlNlbGVjdFJlc3VsdHMiLCJpc09iamVjdCIsInBhcnNlWG1sIiwicmVhZGFibGVTdHJlYW0iLCJzYW5pdGl6ZUVUYWciLCJzYW5pdGl6ZU9iamVjdEtleSIsInNhbml0aXplU2l6ZSIsInRvQXJyYXkiLCJyZWFkQXNTdHJpbmciLCJSRVRFTlRJT05fVkFMSURJVFlfVU5JVFMiLCJwYXJzZUJ1Y2tldFJlZ2lvbiIsInhtbCIsIkxvY2F0aW9uQ29uc3RyYWludCIsImZ4cCIsImZ4cFdpdGhvdXROdW1QYXJzZXIiLCJudW1iZXJQYXJzZU9wdGlvbnMiLCJza2lwTGlrZSIsInBhcnNlRXJyb3IiLCJoZWFkZXJJbmZvIiwieG1sRXJyIiwieG1sT2JqIiwicGFyc2UiLCJFcnJvciIsImUiLCJTM0Vycm9yIiwiT2JqZWN0IiwiZW50cmllcyIsImZvckVhY2giLCJrZXkiLCJ2YWx1ZSIsInRvTG93ZXJDYXNlIiwicGFyc2VSZXNwb25zZUVycm9yIiwicmVzcG9uc2UiLCJzdGF0dXNDb2RlIiwiY29kZSIsIm1lc3NhZ2UiLCJoRXJyQ29kZSIsImhlYWRlcnMiLCJoRXJyRGVzYyIsImFtelJlcXVlc3RpZCIsImFteklkMiIsImFtekJ1Y2tldFJlZ2lvbiIsInhtbFN0cmluZyIsImNhdXNlIiwicGFyc2VMaXN0T2JqZWN0c1YyV2l0aE1ldGFkYXRhIiwicmVzdWx0Iiwib2JqZWN0cyIsImlzVHJ1bmNhdGVkIiwibmV4dENvbnRpbnVhdGlvblRva2VuIiwieG1sb2JqIiwiTGlzdEJ1Y2tldFJlc3VsdCIsIkludmFsaWRYTUxFcnJvciIsIklzVHJ1bmNhdGVkIiwiTmV4dENvbnRpbnVhdGlvblRva2VuIiwiQ29udGVudHMiLCJjb250ZW50IiwibmFtZSIsIktleSIsImxhc3RNb2RpZmllZCIsIkRhdGUiLCJMYXN0TW9kaWZpZWQiLCJldGFnIiwiRVRhZyIsInNpemUiLCJTaXplIiwidGFncyIsIlVzZXJUYWdzIiwic3BsaXQiLCJ0YWciLCJtZXRhZGF0YSIsIlVzZXJNZXRhZGF0YSIsInB1c2giLCJDb21tb25QcmVmaXhlcyIsImNvbW1vblByZWZpeCIsInByZWZpeCIsIlByZWZpeCIsInBhcnNlTGlzdFBhcnRzIiwicGFydHMiLCJtYXJrZXIiLCJMaXN0UGFydHNSZXN1bHQiLCJOZXh0UGFydE51bWJlck1hcmtlciIsIlBhcnQiLCJwIiwicGFydCIsInBhcnNlSW50IiwiUGFydE51bWJlciIsInJlcGxhY2UiLCJwYXJzZUxpc3RCdWNrZXQiLCJsaXN0QnVja2V0UmVzdWx0UGFyc2VyIiwicGFyc2VUYWdWYWx1ZSIsImxlYWRpbmdaZXJvcyIsImhleCIsInRhZ1ZhbHVlUHJvY2Vzc29yIiwidGFnTmFtZSIsInRhZ1ZhbHVlIiwidG9TdHJpbmciLCJpZ25vcmVBdHRyaWJ1dGVzIiwicGFyc2VkWG1sUmVzIiwiTGlzdEFsbE15QnVja2V0c1Jlc3VsdCIsIkJ1Y2tldHMiLCJCdWNrZXQiLCJtYXAiLCJidWNrZXQiLCJOYW1lIiwiYnVja2V0TmFtZSIsIkNyZWF0aW9uRGF0ZSIsImNyZWF0aW9uRGF0ZSIsInBhcnNlSW5pdGlhdGVNdWx0aXBhcnQiLCJJbml0aWF0ZU11bHRpcGFydFVwbG9hZFJlc3VsdCIsIlVwbG9hZElkIiwicGFyc2VSZXBsaWNhdGlvbkNvbmZpZyIsIlJvbGUiLCJSdWxlIiwiUmVwbGljYXRpb25Db25maWd1cmF0aW9uIiwicm9sZSIsInJ1bGVzIiwicGFyc2VPYmplY3RMZWdhbEhvbGRDb25maWciLCJMZWdhbEhvbGQiLCJwYXJzZVRhZ2dpbmciLCJUYWdnaW5nIiwiVGFnU2V0IiwiVGFnIiwidGFnUmVzdWx0IiwiQXJyYXkiLCJpc0FycmF5IiwicGFyc2VDb21wbGV0ZU11bHRpcGFydCIsIkNvbXBsZXRlTXVsdGlwYXJ0VXBsb2FkUmVzdWx0IiwiTG9jYXRpb24iLCJsb2NhdGlvbiIsIkNvZGUiLCJNZXNzYWdlIiwiZXJyQ29kZSIsImVyck1lc3NhZ2UiLCJwYXJzZUxpc3RNdWx0aXBhcnQiLCJwcmVmaXhlcyIsInVwbG9hZHMiLCJuZXh0S2V5TWFya2VyIiwibmV4dFVwbG9hZElkTWFya2VyIiwiTGlzdE11bHRpcGFydFVwbG9hZHNSZXN1bHQiLCJOZXh0S2V5TWFya2VyIiwiTmV4dFVwbG9hZElkTWFya2VyIiwiVXBsb2FkIiwidXBsb2FkIiwidXBsb2FkSXRlbSIsInVwbG9hZElkIiwic3RvcmFnZUNsYXNzIiwiU3RvcmFnZUNsYXNzIiwiaW5pdGlhdGVkIiwiSW5pdGlhdGVkIiwiSW5pdGlhdG9yIiwiaW5pdGlhdG9yIiwiaWQiLCJJRCIsImRpc3BsYXlOYW1lIiwiRGlzcGxheU5hbWUiLCJPd25lciIsIm93bmVyIiwicGFyc2VPYmplY3RMb2NrQ29uZmlnIiwibG9ja0NvbmZpZ1Jlc3VsdCIsIk9iamVjdExvY2tDb25maWd1cmF0aW9uIiwib2JqZWN0TG9ja0VuYWJsZWQiLCJPYmplY3RMb2NrRW5hYmxlZCIsInJldGVudGlvblJlc3AiLCJEZWZhdWx0UmV0ZW50aW9uIiwibW9kZSIsIk1vZGUiLCJpc1VuaXRZZWFycyIsIlllYXJzIiwidmFsaWRpdHkiLCJ1bml0IiwiWUVBUlMiLCJEYXlzIiwiREFZUyIsInBhcnNlQnVja2V0VmVyc2lvbmluZ0NvbmZpZyIsIlZlcnNpb25pbmdDb25maWd1cmF0aW9uIiwiZXh0cmFjdEhlYWRlclR5cGUiLCJzdHJlYW0iLCJoZWFkZXJOYW1lTGVuIiwiQnVmZmVyIiwiZnJvbSIsInJlYWQiLCJyZWFkVUludDgiLCJoZWFkZXJOYW1lV2l0aFNlcGFyYXRvciIsInNwbGl0QnlTZXBhcmF0b3IiLCJsZW5ndGgiLCJleHRyYWN0SGVhZGVyVmFsdWUiLCJib2R5TGVuIiwicmVhZFVJbnQxNkJFIiwicGFyc2VTZWxlY3RPYmplY3RDb250ZW50UmVzcG9uc2UiLCJyZXMiLCJzZWxlY3RSZXN1bHRzIiwicmVzcG9uc2VTdHJlYW0iLCJfcmVhZGFibGVTdGF0ZSIsIm1zZ0NyY0FjY3VtdWxhdG9yIiwidG90YWxCeXRlTGVuZ3RoQnVmZmVyIiwiaGVhZGVyQnl0ZXNCdWZmZXIiLCJjYWxjdWxhdGVkUHJlbHVkZUNyYyIsInJlYWRJbnQzMkJFIiwicHJlbHVkZUNyY0J1ZmZlciIsInRvdGFsTXNnTGVuZ3RoIiwiaGVhZGVyTGVuZ3RoIiwicHJlbHVkZUNyY0J5dGVWYWx1ZSIsImhlYWRlckJ5dGVzIiwiaGVhZGVyUmVhZGVyU3RyZWFtIiwiaGVhZGVyVHlwZU5hbWUiLCJwYXlsb2FkU3RyZWFtIiwicGF5TG9hZExlbmd0aCIsInBheUxvYWRCdWZmZXIiLCJtZXNzYWdlQ3JjQnl0ZVZhbHVlIiwiY2FsY3VsYXRlZENyYyIsIm1lc3NhZ2VUeXBlIiwiZXJyb3JNZXNzYWdlIiwiY29udGVudFR5cGUiLCJldmVudFR5cGUiLCJzZXRSZXNwb25zZSIsIl9wYXlsb2FkU3RyZWFtIiwicmVhZERhdGEiLCJzZXRSZWNvcmRzIiwiX3BheWxvYWRTdHJlYW0yIiwicHJvZ3Jlc3NEYXRhIiwic2V0UHJvZ3Jlc3MiLCJfcGF5bG9hZFN0cmVhbTMiLCJzdGF0c0RhdGEiLCJzZXRTdGF0cyIsIndhcm5pbmdNZXNzYWdlIiwiY29uc29sZSIsIndhcm4iLCJwYXJzZUxpZmVjeWNsZUNvbmZpZyIsIkxpZmVjeWNsZUNvbmZpZ3VyYXRpb24iLCJwYXJzZUJ1Y2tldEVuY3J5cHRpb25Db25maWciLCJwYXJzZU9iamVjdFJldGVudGlvbkNvbmZpZyIsInJldGVudGlvbkNvbmZpZyIsIlJldGVudGlvbiIsInJldGFpblVudGlsRGF0ZSIsIlJldGFpblVudGlsRGF0ZSIsInJlbW92ZU9iamVjdHNQYXJzZXIiLCJEZWxldGVSZXN1bHQiLCJwYXJzZUNvcHlPYmplY3QiLCJDb3B5T2JqZWN0UmVzdWx0IiwiZm9ybWF0T2JqSW5mbyIsIm9wdHMiLCJWZXJzaW9uSWQiLCJJc0xhdGVzdCIsInVuZGVmaW5lZCIsInZlcnNpb25JZCIsImlzTGF0ZXN0IiwiaXNEZWxldGVNYXJrZXIiLCJJc0RlbGV0ZU1hcmtlciIsInBhcnNlTGlzdE9iamVjdHMiLCJuZXh0TWFya2VyIiwidmVyc2lvbklkTWFya2VyIiwia2V5TWFya2VyIiwicGFyc2VDb21tb25QcmVmaXhlc0VudGl0eSIsImNvbW1vblByZWZpeEVudHJ5IiwibGlzdEJ1Y2tldFJlc3VsdCIsImxpc3RWZXJzaW9uc1Jlc3VsdCIsIkxpc3RWZXJzaW9uc1Jlc3VsdCIsIk1hcmtlciIsIk5leHRNYXJrZXIiLCJfcmVzdWx0JG9iamVjdHMiLCJWZXJzaW9uIiwiRGVsZXRlTWFya2VyIiwiTmV4dFZlcnNpb25JZE1hcmtlciIsInVwbG9hZFBhcnRQYXJzZXIiLCJyZXNwRWwiLCJDb3B5UGFydFJlc3VsdCJdLCJzb3VyY2VzIjpbInhtbC1wYXJzZXIudHMiXSwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHR5cGUgKiBhcyBodHRwIGZyb20gJ25vZGU6aHR0cCdcbmltcG9ydCB0eXBlIHN0cmVhbSBmcm9tICdub2RlOnN0cmVhbSdcblxuaW1wb3J0IGNyYzMyIGZyb20gJ2J1ZmZlci1jcmMzMidcbmltcG9ydCB7IFhNTFBhcnNlciB9IGZyb20gJ2Zhc3QteG1sLXBhcnNlcidcblxuaW1wb3J0ICogYXMgZXJyb3JzIGZyb20gJy4uL2Vycm9ycy50cydcbmltcG9ydCB7IFNlbGVjdFJlc3VsdHMgfSBmcm9tICcuLi9oZWxwZXJzLnRzJ1xuaW1wb3J0IHsgaXNPYmplY3QsIHBhcnNlWG1sLCByZWFkYWJsZVN0cmVhbSwgc2FuaXRpemVFVGFnLCBzYW5pdGl6ZU9iamVjdEtleSwgc2FuaXRpemVTaXplLCB0b0FycmF5IH0gZnJvbSAnLi9oZWxwZXIudHMnXG5pbXBvcnQgeyByZWFkQXNTdHJpbmcgfSBmcm9tICcuL3Jlc3BvbnNlLnRzJ1xuaW1wb3J0IHR5cGUge1xuICBCdWNrZXRJdGVtRnJvbUxpc3QsXG4gIEJ1Y2tldEl0ZW1XaXRoTWV0YWRhdGEsXG4gIENvbW1vblByZWZpeCxcbiAgQ29weU9iamVjdFJlc3VsdFYxLFxuICBMaXN0QnVja2V0UmVzdWx0VjEsXG4gIE9iamVjdEluZm8sXG4gIE9iamVjdExvY2tJbmZvLFxuICBPYmplY3RSb3dFbnRyeSxcbiAgUmVwbGljYXRpb25Db25maWcsXG4gIFRhZyxcbiAgVGFncyxcbn0gZnJvbSAnLi90eXBlLnRzJ1xuaW1wb3J0IHsgUkVURU5USU9OX1ZBTElESVRZX1VOSVRTIH0gZnJvbSAnLi90eXBlLnRzJ1xuXG4vLyBwYXJzZSBYTUwgcmVzcG9uc2UgZm9yIGJ1Y2tldCByZWdpb25cbmV4cG9ydCBmdW5jdGlvbiBwYXJzZUJ1Y2tldFJlZ2lvbih4bWw6IHN0cmluZyk6IHN0cmluZyB7XG4gIC8vIHJldHVybiByZWdpb24gaW5mb3JtYXRpb25cbiAgcmV0dXJuIHBhcnNlWG1sKHhtbCkuTG9jYXRpb25Db25zdHJhaW50XG59XG5cbmNvbnN0IGZ4cCA9IG5ldyBYTUxQYXJzZXIoKVxuXG5jb25zdCBmeHBXaXRob3V0TnVtUGFyc2VyID0gbmV3IFhNTFBhcnNlcih7XG4gIC8vIEB0cy1pZ25vcmVcbiAgbnVtYmVyUGFyc2VPcHRpb25zOiB7XG4gICAgc2tpcExpa2U6IC8uLyxcbiAgfSxcbn0pXG5cbi8vIFBhcnNlIFhNTCBhbmQgcmV0dXJuIGluZm9ybWF0aW9uIGFzIEphdmFzY3JpcHQgdHlwZXNcbi8vIHBhcnNlIGVycm9yIFhNTCByZXNwb25zZVxuZXhwb3J0IGZ1bmN0aW9uIHBhcnNlRXJyb3IoeG1sOiBzdHJpbmcsIGhlYWRlckluZm86IFJlY29yZDxzdHJpbmcsIHVua25vd24+KSB7XG4gIGxldCB4bWxFcnIgPSB7fVxuICBjb25zdCB4bWxPYmogPSBmeHAucGFyc2UoeG1sKVxuICBpZiAoeG1sT2JqLkVycm9yKSB7XG4gICAgeG1sRXJyID0geG1sT2JqLkVycm9yXG4gIH1cbiAgY29uc3QgZSA9IG5ldyBlcnJvcnMuUzNFcnJvcigpIGFzIHVua25vd24gYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj5cbiAgT2JqZWN0LmVudHJpZXMoeG1sRXJyKS5mb3JFYWNoKChba2V5LCB2YWx1ZV0pID0+IHtcbiAgICBlW2tleS50b0xvd2VyQ2FzZSgpXSA9IHZhbHVlXG4gIH0pXG4gIE9iamVjdC5lbnRyaWVzKGhlYWRlckluZm8pLmZvckVhY2goKFtrZXksIHZhbHVlXSkgPT4ge1xuICAgIGVba2V5XSA9IHZhbHVlXG4gIH0pXG4gIHJldHVybiBlXG59XG5cbi8vIEdlbmVyYXRlcyBhbiBFcnJvciBvYmplY3QgZGVwZW5kaW5nIG9uIGh0dHAgc3RhdHVzQ29kZSBhbmQgWE1MIGJvZHlcbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBwYXJzZVJlc3BvbnNlRXJyb3IocmVzcG9uc2U6IGh0dHAuSW5jb21pbmdNZXNzYWdlKTogUHJvbWlzZTxSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+PiB7XG4gIGNvbnN0IHN0YXR1c0NvZGUgPSByZXNwb25zZS5zdGF0dXNDb2RlXG4gIGxldCBjb2RlID0gJycsXG4gICAgbWVzc2FnZSA9ICcnXG4gIGlmIChzdGF0dXNDb2RlID09PSAzMDEpIHtcbiAgICBjb2RlID0gJ01vdmVkUGVybWFuZW50bHknXG4gICAgbWVzc2FnZSA9ICdNb3ZlZCBQZXJtYW5lbnRseSdcbiAgfSBlbHNlIGlmIChzdGF0dXNDb2RlID09PSAzMDcpIHtcbiAgICBjb2RlID0gJ1RlbXBvcmFyeVJlZGlyZWN0J1xuICAgIG1lc3NhZ2UgPSAnQXJlIHlvdSB1c2luZyB0aGUgY29ycmVjdCBlbmRwb2ludCBVUkw/J1xuICB9IGVsc2UgaWYgKHN0YXR1c0NvZGUgPT09IDQwMykge1xuICAgIGNvZGUgPSAnQWNjZXNzRGVuaWVkJ1xuICAgIG1lc3NhZ2UgPSAnVmFsaWQgYW5kIGF1dGhvcml6ZWQgY3JlZGVudGlhbHMgcmVxdWlyZWQnXG4gIH0gZWxzZSBpZiAoc3RhdHVzQ29kZSA9PT0gNDA0KSB7XG4gICAgY29kZSA9ICdOb3RGb3VuZCdcbiAgICBtZXNzYWdlID0gJ05vdCBGb3VuZCdcbiAgfSBlbHNlIGlmIChzdGF0dXNDb2RlID09PSA0MDUpIHtcbiAgICBjb2RlID0gJ01ldGhvZE5vdEFsbG93ZWQnXG4gICAgbWVzc2FnZSA9ICdNZXRob2QgTm90IEFsbG93ZWQnXG4gIH0gZWxzZSBpZiAoc3RhdHVzQ29kZSA9PT0gNTAxKSB7XG4gICAgY29kZSA9ICdNZXRob2ROb3RBbGxvd2VkJ1xuICAgIG1lc3NhZ2UgPSAnTWV0aG9kIE5vdCBBbGxvd2VkJ1xuICB9IGVsc2UgaWYgKHN0YXR1c0NvZGUgPT09IDUwMykge1xuICAgIGNvZGUgPSAnU2xvd0Rvd24nXG4gICAgbWVzc2FnZSA9ICdQbGVhc2UgcmVkdWNlIHlvdXIgcmVxdWVzdCByYXRlLidcbiAgfSBlbHNlIHtcbiAgICBjb25zdCBoRXJyQ29kZSA9IHJlc3BvbnNlLmhlYWRlcnNbJ3gtbWluaW8tZXJyb3ItY29kZSddIGFzIHN0cmluZ1xuICAgIGNvbnN0IGhFcnJEZXNjID0gcmVzcG9uc2UuaGVhZGVyc1sneC1taW5pby1lcnJvci1kZXNjJ10gYXMgc3RyaW5nXG5cbiAgICBpZiAoaEVyckNvZGUgJiYgaEVyckRlc2MpIHtcbiAgICAgIGNvZGUgPSBoRXJyQ29kZVxuICAgICAgbWVzc2FnZSA9IGhFcnJEZXNjXG4gICAgfVxuICB9XG4gIGNvbnN0IGhlYWRlckluZm86IFJlY29yZDxzdHJpbmcsIHN0cmluZyB8IHVuZGVmaW5lZCB8IG51bGw+ID0ge31cbiAgLy8gQSB2YWx1ZSBjcmVhdGVkIGJ5IFMzIGNvbXBhdGlibGUgc2VydmVyIHRoYXQgdW5pcXVlbHkgaWRlbnRpZmllcyB0aGUgcmVxdWVzdC5cbiAgaGVhZGVySW5mby5hbXpSZXF1ZXN0aWQgPSByZXNwb25zZS5oZWFkZXJzWyd4LWFtei1yZXF1ZXN0LWlkJ10gYXMgc3RyaW5nIHwgdW5kZWZpbmVkXG4gIC8vIEEgc3BlY2lhbCB0b2tlbiB0aGF0IGhlbHBzIHRyb3VibGVzaG9vdCBBUEkgcmVwbGllcyBhbmQgaXNzdWVzLlxuICBoZWFkZXJJbmZvLmFteklkMiA9IHJlc3BvbnNlLmhlYWRlcnNbJ3gtYW16LWlkLTInXSBhcyBzdHJpbmcgfCB1bmRlZmluZWRcblxuICAvLyBSZWdpb24gd2hlcmUgdGhlIGJ1Y2tldCBpcyBsb2NhdGVkLiBUaGlzIGhlYWRlciBpcyByZXR1cm5lZCBvbmx5XG4gIC8vIGluIEhFQUQgYnVja2V0IGFuZCBMaXN0T2JqZWN0cyByZXNwb25zZS5cbiAgaGVhZGVySW5mby5hbXpCdWNrZXRSZWdpb24gPSByZXNwb25zZS5oZWFkZXJzWyd4LWFtei1idWNrZXQtcmVnaW9uJ10gYXMgc3RyaW5nIHwgdW5kZWZpbmVkXG5cbiAgY29uc3QgeG1sU3RyaW5nID0gYXdhaXQgcmVhZEFzU3RyaW5nKHJlc3BvbnNlKVxuXG4gIGlmICh4bWxTdHJpbmcpIHtcbiAgICB0aHJvdyBwYXJzZUVycm9yKHhtbFN0cmluZywgaGVhZGVySW5mbylcbiAgfVxuXG4gIC8vIE1lc3NhZ2Ugc2hvdWxkIGJlIGluc3RhbnRpYXRlZCBmb3IgZWFjaCBTM0Vycm9ycy5cbiAgY29uc3QgZSA9IG5ldyBlcnJvcnMuUzNFcnJvcihtZXNzYWdlLCB7IGNhdXNlOiBoZWFkZXJJbmZvIH0pXG4gIC8vIFMzIEVycm9yIGNvZGUuXG4gIGUuY29kZSA9IGNvZGVcbiAgT2JqZWN0LmVudHJpZXMoaGVhZGVySW5mbykuZm9yRWFjaCgoW2tleSwgdmFsdWVdKSA9PiB7XG4gICAgLy8gQHRzLWV4cGVjdC1lcnJvciBmb3JjZSBzZXQgZXJyb3IgcHJvcGVydGllc1xuICAgIGVba2V5XSA9IHZhbHVlXG4gIH0pXG5cbiAgdGhyb3cgZVxufVxuXG4vKipcbiAqIHBhcnNlIFhNTCByZXNwb25zZSBmb3IgbGlzdCBvYmplY3RzIHYyIHdpdGggbWV0YWRhdGEgaW4gYSBidWNrZXRcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHBhcnNlTGlzdE9iamVjdHNWMldpdGhNZXRhZGF0YSh4bWw6IHN0cmluZykge1xuICBjb25zdCByZXN1bHQ6IHtcbiAgICBvYmplY3RzOiBBcnJheTxCdWNrZXRJdGVtV2l0aE1ldGFkYXRhPlxuICAgIGlzVHJ1bmNhdGVkOiBib29sZWFuXG4gICAgbmV4dENvbnRpbnVhdGlvblRva2VuOiBzdHJpbmdcbiAgfSA9IHtcbiAgICBvYmplY3RzOiBbXSxcbiAgICBpc1RydW5jYXRlZDogZmFsc2UsXG4gICAgbmV4dENvbnRpbnVhdGlvblRva2VuOiAnJyxcbiAgfVxuXG4gIGxldCB4bWxvYmogPSBwYXJzZVhtbCh4bWwpXG4gIGlmICgheG1sb2JqLkxpc3RCdWNrZXRSZXN1bHQpIHtcbiAgICB0aHJvdyBuZXcgZXJyb3JzLkludmFsaWRYTUxFcnJvcignTWlzc2luZyB0YWc6IFwiTGlzdEJ1Y2tldFJlc3VsdFwiJylcbiAgfVxuICB4bWxvYmogPSB4bWxvYmouTGlzdEJ1Y2tldFJlc3VsdFxuICBpZiAoeG1sb2JqLklzVHJ1bmNhdGVkKSB7XG4gICAgcmVzdWx0LmlzVHJ1bmNhdGVkID0geG1sb2JqLklzVHJ1bmNhdGVkXG4gIH1cbiAgaWYgKHhtbG9iai5OZXh0Q29udGludWF0aW9uVG9rZW4pIHtcbiAgICByZXN1bHQubmV4dENvbnRpbnVhdGlvblRva2VuID0geG1sb2JqLk5leHRDb250aW51YXRpb25Ub2tlblxuICB9XG5cbiAgaWYgKHhtbG9iai5Db250ZW50cykge1xuICAgIHRvQXJyYXkoeG1sb2JqLkNvbnRlbnRzKS5mb3JFYWNoKChjb250ZW50KSA9PiB7XG4gICAgICBjb25zdCBuYW1lID0gc2FuaXRpemVPYmplY3RLZXkoY29udGVudC5LZXkpXG4gICAgICBjb25zdCBsYXN0TW9kaWZpZWQgPSBuZXcgRGF0ZShjb250ZW50Lkxhc3RNb2RpZmllZClcbiAgICAgIGNvbnN0IGV0YWcgPSBzYW5pdGl6ZUVUYWcoY29udGVudC5FVGFnKVxuICAgICAgY29uc3Qgc2l6ZSA9IGNvbnRlbnQuU2l6ZVxuXG4gICAgICBsZXQgdGFnczogVGFncyA9IHt9XG4gICAgICBpZiAoY29udGVudC5Vc2VyVGFncyAhPSBudWxsKSB7XG4gICAgICAgIHRvQXJyYXkoY29udGVudC5Vc2VyVGFncy5zcGxpdCgnJicpKS5mb3JFYWNoKCh0YWcpID0+IHtcbiAgICAgICAgICBjb25zdCBba2V5LCB2YWx1ZV0gPSB0YWcuc3BsaXQoJz0nKVxuICAgICAgICAgIHRhZ3Nba2V5XSA9IHZhbHVlXG4gICAgICAgIH0pXG4gICAgICB9IGVsc2Uge1xuICAgICAgICB0YWdzID0ge31cbiAgICAgIH1cblxuICAgICAgbGV0IG1ldGFkYXRhXG4gICAgICBpZiAoY29udGVudC5Vc2VyTWV0YWRhdGEgIT0gbnVsbCkge1xuICAgICAgICBtZXRhZGF0YSA9IHRvQXJyYXkoY29udGVudC5Vc2VyTWV0YWRhdGEpWzBdXG4gICAgICB9IGVsc2Uge1xuICAgICAgICBtZXRhZGF0YSA9IG51bGxcbiAgICAgIH1cbiAgICAgIHJlc3VsdC5vYmplY3RzLnB1c2goeyBuYW1lLCBsYXN0TW9kaWZpZWQsIGV0YWcsIHNpemUsIG1ldGFkYXRhLCB0YWdzIH0pXG4gICAgfSlcbiAgfVxuXG4gIGlmICh4bWxvYmouQ29tbW9uUHJlZml4ZXMpIHtcbiAgICB0b0FycmF5KHhtbG9iai5Db21tb25QcmVmaXhlcykuZm9yRWFjaCgoY29tbW9uUHJlZml4KSA9PiB7XG4gICAgICByZXN1bHQub2JqZWN0cy5wdXNoKHsgcHJlZml4OiBzYW5pdGl6ZU9iamVjdEtleSh0b0FycmF5KGNvbW1vblByZWZpeC5QcmVmaXgpWzBdKSwgc2l6ZTogMCB9KVxuICAgIH0pXG4gIH1cbiAgcmV0dXJuIHJlc3VsdFxufVxuXG5leHBvcnQgdHlwZSBVcGxvYWRlZFBhcnQgPSB7XG4gIHBhcnQ6IG51bWJlclxuICBsYXN0TW9kaWZpZWQ/OiBEYXRlXG4gIGV0YWc6IHN0cmluZ1xuICBzaXplOiBudW1iZXJcbn1cblxuLy8gcGFyc2UgWE1MIHJlc3BvbnNlIGZvciBsaXN0IHBhcnRzIG9mIGFuIGluIHByb2dyZXNzIG11bHRpcGFydCB1cGxvYWRcbmV4cG9ydCBmdW5jdGlvbiBwYXJzZUxpc3RQYXJ0cyh4bWw6IHN0cmluZyk6IHtcbiAgaXNUcnVuY2F0ZWQ6IGJvb2xlYW5cbiAgbWFya2VyOiBudW1iZXJcbiAgcGFydHM6IFVwbG9hZGVkUGFydFtdXG59IHtcbiAgbGV0IHhtbG9iaiA9IHBhcnNlWG1sKHhtbClcbiAgY29uc3QgcmVzdWx0OiB7XG4gICAgaXNUcnVuY2F0ZWQ6IGJvb2xlYW5cbiAgICBtYXJrZXI6IG51bWJlclxuICAgIHBhcnRzOiBVcGxvYWRlZFBhcnRbXVxuICB9ID0ge1xuICAgIGlzVHJ1bmNhdGVkOiBmYWxzZSxcbiAgICBwYXJ0czogW10sXG4gICAgbWFya2VyOiAwLFxuICB9XG4gIGlmICgheG1sb2JqLkxpc3RQYXJ0c1Jlc3VsdCkge1xuICAgIHRocm93IG5ldyBlcnJvcnMuSW52YWxpZFhNTEVycm9yKCdNaXNzaW5nIHRhZzogXCJMaXN0UGFydHNSZXN1bHRcIicpXG4gIH1cbiAgeG1sb2JqID0geG1sb2JqLkxpc3RQYXJ0c1Jlc3VsdFxuICBpZiAoeG1sb2JqLklzVHJ1bmNhdGVkKSB7XG4gICAgcmVzdWx0LmlzVHJ1bmNhdGVkID0geG1sb2JqLklzVHJ1bmNhdGVkXG4gIH1cbiAgaWYgKHhtbG9iai5OZXh0UGFydE51bWJlck1hcmtlcikge1xuICAgIHJlc3VsdC5tYXJrZXIgPSB0b0FycmF5KHhtbG9iai5OZXh0UGFydE51bWJlck1hcmtlcilbMF0gfHwgJydcbiAgfVxuICBpZiAoeG1sb2JqLlBhcnQpIHtcbiAgICB0b0FycmF5KHhtbG9iai5QYXJ0KS5mb3JFYWNoKChwKSA9PiB7XG4gICAgICBjb25zdCBwYXJ0ID0gcGFyc2VJbnQodG9BcnJheShwLlBhcnROdW1iZXIpWzBdLCAxMClcbiAgICAgIGNvbnN0IGxhc3RNb2RpZmllZCA9IG5ldyBEYXRlKHAuTGFzdE1vZGlmaWVkKVxuICAgICAgY29uc3QgZXRhZyA9IHAuRVRhZy5yZXBsYWNlKC9eXCIvZywgJycpXG4gICAgICAgIC5yZXBsYWNlKC9cIiQvZywgJycpXG4gICAgICAgIC5yZXBsYWNlKC9eJnF1b3Q7L2csICcnKVxuICAgICAgICAucmVwbGFjZSgvJnF1b3Q7JC9nLCAnJylcbiAgICAgICAgLnJlcGxhY2UoL14mIzM0Oy9nLCAnJylcbiAgICAgICAgLnJlcGxhY2UoLyYjMzQ7JC9nLCAnJylcbiAgICAgIHJlc3VsdC5wYXJ0cy5wdXNoKHsgcGFydCwgbGFzdE1vZGlmaWVkLCBldGFnLCBzaXplOiBwYXJzZUludChwLlNpemUsIDEwKSB9KVxuICAgIH0pXG4gIH1cbiAgcmV0dXJuIHJlc3VsdFxufVxuXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VMaXN0QnVja2V0KHhtbDogc3RyaW5nKTogQnVja2V0SXRlbUZyb21MaXN0W10ge1xuICBsZXQgcmVzdWx0OiBCdWNrZXRJdGVtRnJvbUxpc3RbXSA9IFtdXG4gIGNvbnN0IGxpc3RCdWNrZXRSZXN1bHRQYXJzZXIgPSBuZXcgWE1MUGFyc2VyKHtcbiAgICBwYXJzZVRhZ1ZhbHVlOiB0cnVlLCAvLyBFbmFibGUgcGFyc2luZyBvZiB2YWx1ZXNcbiAgICBudW1iZXJQYXJzZU9wdGlvbnM6IHtcbiAgICAgIGxlYWRpbmdaZXJvczogZmFsc2UsIC8vIERpc2FibGUgbnVtYmVyIHBhcnNpbmcgZm9yIHZhbHVlcyB3aXRoIGxlYWRpbmcgemVyb3NcbiAgICAgIGhleDogZmFsc2UsIC8vIERpc2FibGUgaGV4IG51bWJlciBwYXJzaW5nIC0gSW52YWxpZCBidWNrZXQgbmFtZVxuICAgICAgc2tpcExpa2U6IC9eWzAtOV0rJC8sIC8vIFNraXAgbnVtYmVyIHBhcnNpbmcgaWYgdGhlIHZhbHVlIGNvbnNpc3RzIGVudGlyZWx5IG9mIGRpZ2l0c1xuICAgIH0sXG4gICAgdGFnVmFsdWVQcm9jZXNzb3I6ICh0YWdOYW1lLCB0YWdWYWx1ZSA9ICcnKSA9PiB7XG4gICAgICAvLyBFbnN1cmUgdGhhdCB0aGUgTmFtZSB0YWcgaXMgYWx3YXlzIHRyZWF0ZWQgYXMgYSBzdHJpbmdcbiAgICAgIGlmICh0YWdOYW1lID09PSAnTmFtZScpIHtcbiAgICAgICAgcmV0dXJuIHRhZ1ZhbHVlLnRvU3RyaW5nKClcbiAgICAgIH1cbiAgICAgIHJldHVybiB0YWdWYWx1ZVxuICAgIH0sXG4gICAgaWdub3JlQXR0cmlidXRlczogZmFsc2UsIC8vIEVuc3VyZSB0aGF0IGFsbCBhdHRyaWJ1dGVzIGFyZSBwYXJzZWRcbiAgfSlcblxuICBjb25zdCBwYXJzZWRYbWxSZXMgPSBsaXN0QnVja2V0UmVzdWx0UGFyc2VyLnBhcnNlKHhtbClcblxuICBpZiAoIXBhcnNlZFhtbFJlcy5MaXN0QWxsTXlCdWNrZXRzUmVzdWx0KSB7XG4gICAgdGhyb3cgbmV3IGVycm9ycy5JbnZhbGlkWE1MRXJyb3IoJ01pc3NpbmcgdGFnOiBcIkxpc3RBbGxNeUJ1Y2tldHNSZXN1bHRcIicpXG4gIH1cblxuICBjb25zdCB7IExpc3RBbGxNeUJ1Y2tldHNSZXN1bHQ6IHsgQnVja2V0cyA9IHt9IH0gPSB7fSB9ID0gcGFyc2VkWG1sUmVzXG5cbiAgaWYgKEJ1Y2tldHMuQnVja2V0KSB7XG4gICAgcmVzdWx0ID0gdG9BcnJheShCdWNrZXRzLkJ1Y2tldCkubWFwKChidWNrZXQgPSB7fSkgPT4ge1xuICAgICAgY29uc3QgeyBOYW1lOiBidWNrZXROYW1lLCBDcmVhdGlvbkRhdGUgfSA9IGJ1Y2tldFxuICAgICAgY29uc3QgY3JlYXRpb25EYXRlID0gbmV3IERhdGUoQ3JlYXRpb25EYXRlKVxuXG4gICAgICByZXR1cm4geyBuYW1lOiBidWNrZXROYW1lLCBjcmVhdGlvbkRhdGUgfVxuICAgIH0pXG4gIH1cblxuICByZXR1cm4gcmVzdWx0XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBwYXJzZUluaXRpYXRlTXVsdGlwYXJ0KHhtbDogc3RyaW5nKTogc3RyaW5nIHtcbiAgbGV0IHhtbG9iaiA9IHBhcnNlWG1sKHhtbClcblxuICBpZiAoIXhtbG9iai5Jbml0aWF0ZU11bHRpcGFydFVwbG9hZFJlc3VsdCkge1xuICAgIHRocm93IG5ldyBlcnJvcnMuSW52YWxpZFhNTEVycm9yKCdNaXNzaW5nIHRhZzogXCJJbml0aWF0ZU11bHRpcGFydFVwbG9hZFJlc3VsdFwiJylcbiAgfVxuICB4bWxvYmogPSB4bWxvYmouSW5pdGlhdGVNdWx0aXBhcnRVcGxvYWRSZXN1bHRcblxuICBpZiAoeG1sb2JqLlVwbG9hZElkKSB7XG4gICAgcmV0dXJuIHhtbG9iai5VcGxvYWRJZFxuICB9XG4gIHRocm93IG5ldyBlcnJvcnMuSW52YWxpZFhNTEVycm9yKCdNaXNzaW5nIHRhZzogXCJVcGxvYWRJZFwiJylcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHBhcnNlUmVwbGljYXRpb25Db25maWcoeG1sOiBzdHJpbmcpOiBSZXBsaWNhdGlvbkNvbmZpZyB7XG4gIGNvbnN0IHhtbE9iaiA9IHBhcnNlWG1sKHhtbClcbiAgY29uc3QgeyBSb2xlLCBSdWxlIH0gPSB4bWxPYmouUmVwbGljYXRpb25Db25maWd1cmF0aW9uXG4gIHJldHVybiB7XG4gICAgUmVwbGljYXRpb25Db25maWd1cmF0aW9uOiB7XG4gICAgICByb2xlOiBSb2xlLFxuICAgICAgcnVsZXM6IHRvQXJyYXkoUnVsZSksXG4gICAgfSxcbiAgfVxufVxuXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VPYmplY3RMZWdhbEhvbGRDb25maWcoeG1sOiBzdHJpbmcpIHtcbiAgY29uc3QgeG1sT2JqID0gcGFyc2VYbWwoeG1sKVxuICByZXR1cm4geG1sT2JqLkxlZ2FsSG9sZFxufVxuXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VUYWdnaW5nKHhtbDogc3RyaW5nKSB7XG4gIGNvbnN0IHhtbE9iaiA9IHBhcnNlWG1sKHhtbClcbiAgbGV0IHJlc3VsdDogVGFnW10gPSBbXVxuICBpZiAoeG1sT2JqLlRhZ2dpbmcgJiYgeG1sT2JqLlRhZ2dpbmcuVGFnU2V0ICYmIHhtbE9iai5UYWdnaW5nLlRhZ1NldC5UYWcpIHtcbiAgICBjb25zdCB0YWdSZXN1bHQ6IFRhZyA9IHhtbE9iai5UYWdnaW5nLlRhZ1NldC5UYWdcbiAgICAvLyBpZiBpdCBpcyBhIHNpbmdsZSB0YWcgY29udmVydCBpbnRvIGFuIGFycmF5IHNvIHRoYXQgdGhlIHJldHVybiB2YWx1ZSBpcyBhbHdheXMgYW4gYXJyYXkuXG4gICAgaWYgKEFycmF5LmlzQXJyYXkodGFnUmVzdWx0KSkge1xuICAgICAgcmVzdWx0ID0gWy4uLnRhZ1Jlc3VsdF1cbiAgICB9IGVsc2Uge1xuICAgICAgcmVzdWx0LnB1c2godGFnUmVzdWx0KVxuICAgIH1cbiAgfVxuICByZXR1cm4gcmVzdWx0XG59XG5cbi8vIHBhcnNlIFhNTCByZXNwb25zZSB3aGVuIGEgbXVsdGlwYXJ0IHVwbG9hZCBpcyBjb21wbGV0ZWRcbmV4cG9ydCBmdW5jdGlvbiBwYXJzZUNvbXBsZXRlTXVsdGlwYXJ0KHhtbDogc3RyaW5nKSB7XG4gIGNvbnN0IHhtbG9iaiA9IHBhcnNlWG1sKHhtbCkuQ29tcGxldGVNdWx0aXBhcnRVcGxvYWRSZXN1bHRcbiAgaWYgKHhtbG9iai5Mb2NhdGlvbikge1xuICAgIGNvbnN0IGxvY2F0aW9uID0gdG9BcnJheSh4bWxvYmouTG9jYXRpb24pWzBdXG4gICAgY29uc3QgYnVja2V0ID0gdG9BcnJheSh4bWxvYmouQnVja2V0KVswXVxuICAgIGNvbnN0IGtleSA9IHhtbG9iai5LZXlcbiAgICBjb25zdCBldGFnID0geG1sb2JqLkVUYWcucmVwbGFjZSgvXlwiL2csICcnKVxuICAgICAgLnJlcGxhY2UoL1wiJC9nLCAnJylcbiAgICAgIC5yZXBsYWNlKC9eJnF1b3Q7L2csICcnKVxuICAgICAgLnJlcGxhY2UoLyZxdW90OyQvZywgJycpXG4gICAgICAucmVwbGFjZSgvXiYjMzQ7L2csICcnKVxuICAgICAgLnJlcGxhY2UoLyYjMzQ7JC9nLCAnJylcblxuICAgIHJldHVybiB7IGxvY2F0aW9uLCBidWNrZXQsIGtleSwgZXRhZyB9XG4gIH1cbiAgLy8gQ29tcGxldGUgTXVsdGlwYXJ0IGNhbiByZXR1cm4gWE1MIEVycm9yIGFmdGVyIGEgMjAwIE9LIHJlc3BvbnNlXG4gIGlmICh4bWxvYmouQ29kZSAmJiB4bWxvYmouTWVzc2FnZSkge1xuICAgIGNvbnN0IGVyckNvZGUgPSB0b0FycmF5KHhtbG9iai5Db2RlKVswXVxuICAgIGNvbnN0IGVyck1lc3NhZ2UgPSB0b0FycmF5KHhtbG9iai5NZXNzYWdlKVswXVxuICAgIHJldHVybiB7IGVyckNvZGUsIGVyck1lc3NhZ2UgfVxuICB9XG59XG5cbnR5cGUgVXBsb2FkSUQgPSBzdHJpbmdcblxuZXhwb3J0IHR5cGUgTGlzdE11bHRpcGFydFJlc3VsdCA9IHtcbiAgdXBsb2Fkczoge1xuICAgIGtleTogc3RyaW5nXG4gICAgdXBsb2FkSWQ6IFVwbG9hZElEXG4gICAgaW5pdGlhdG9yPzogeyBpZDogc3RyaW5nOyBkaXNwbGF5TmFtZTogc3RyaW5nIH1cbiAgICBvd25lcj86IHsgaWQ6IHN0cmluZzsgZGlzcGxheU5hbWU6IHN0cmluZyB9XG4gICAgc3RvcmFnZUNsYXNzOiB1bmtub3duXG4gICAgaW5pdGlhdGVkOiBEYXRlXG4gIH1bXVxuICBwcmVmaXhlczoge1xuICAgIHByZWZpeDogc3RyaW5nXG4gIH1bXVxuICBpc1RydW5jYXRlZDogYm9vbGVhblxuICBuZXh0S2V5TWFya2VyOiBzdHJpbmdcbiAgbmV4dFVwbG9hZElkTWFya2VyOiBzdHJpbmdcbn1cblxuLy8gcGFyc2UgWE1MIHJlc3BvbnNlIGZvciBsaXN0aW5nIGluLXByb2dyZXNzIG11bHRpcGFydCB1cGxvYWRzXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VMaXN0TXVsdGlwYXJ0KHhtbDogc3RyaW5nKTogTGlzdE11bHRpcGFydFJlc3VsdCB7XG4gIGNvbnN0IHJlc3VsdDogTGlzdE11bHRpcGFydFJlc3VsdCA9IHtcbiAgICBwcmVmaXhlczogW10sXG4gICAgdXBsb2FkczogW10sXG4gICAgaXNUcnVuY2F0ZWQ6IGZhbHNlLFxuICAgIG5leHRLZXlNYXJrZXI6ICcnLFxuICAgIG5leHRVcGxvYWRJZE1hcmtlcjogJycsXG4gIH1cblxuICBsZXQgeG1sb2JqID0gcGFyc2VYbWwoeG1sKVxuXG4gIGlmICgheG1sb2JqLkxpc3RNdWx0aXBhcnRVcGxvYWRzUmVzdWx0KSB7XG4gICAgdGhyb3cgbmV3IGVycm9ycy5JbnZhbGlkWE1MRXJyb3IoJ01pc3NpbmcgdGFnOiBcIkxpc3RNdWx0aXBhcnRVcGxvYWRzUmVzdWx0XCInKVxuICB9XG4gIHhtbG9iaiA9IHhtbG9iai5MaXN0TXVsdGlwYXJ0VXBsb2Fkc1Jlc3VsdFxuICBpZiAoeG1sb2JqLklzVHJ1bmNhdGVkKSB7XG4gICAgcmVzdWx0LmlzVHJ1bmNhdGVkID0geG1sb2JqLklzVHJ1bmNhdGVkXG4gIH1cbiAgaWYgKHhtbG9iai5OZXh0S2V5TWFya2VyKSB7XG4gICAgcmVzdWx0Lm5leHRLZXlNYXJrZXIgPSB4bWxvYmouTmV4dEtleU1hcmtlclxuICB9XG4gIGlmICh4bWxvYmouTmV4dFVwbG9hZElkTWFya2VyKSB7XG4gICAgcmVzdWx0Lm5leHRVcGxvYWRJZE1hcmtlciA9IHhtbG9iai5uZXh0VXBsb2FkSWRNYXJrZXIgfHwgJydcbiAgfVxuXG4gIGlmICh4bWxvYmouQ29tbW9uUHJlZml4ZXMpIHtcbiAgICB0b0FycmF5KHhtbG9iai5Db21tb25QcmVmaXhlcykuZm9yRWFjaCgocHJlZml4KSA9PiB7XG4gICAgICAvLyBAdHMtZXhwZWN0LWVycm9yIGluZGV4IGNoZWNrXG4gICAgICByZXN1bHQucHJlZml4ZXMucHVzaCh7IHByZWZpeDogc2FuaXRpemVPYmplY3RLZXkodG9BcnJheTxzdHJpbmc+KHByZWZpeC5QcmVmaXgpWzBdKSB9KVxuICAgIH0pXG4gIH1cblxuICBpZiAoeG1sb2JqLlVwbG9hZCkge1xuICAgIHRvQXJyYXkoeG1sb2JqLlVwbG9hZCkuZm9yRWFjaCgodXBsb2FkKSA9PiB7XG4gICAgICBjb25zdCB1cGxvYWRJdGVtOiBMaXN0TXVsdGlwYXJ0UmVzdWx0Wyd1cGxvYWRzJ11bbnVtYmVyXSA9IHtcbiAgICAgICAga2V5OiB1cGxvYWQuS2V5LFxuICAgICAgICB1cGxvYWRJZDogdXBsb2FkLlVwbG9hZElkLFxuICAgICAgICBzdG9yYWdlQ2xhc3M6IHVwbG9hZC5TdG9yYWdlQ2xhc3MsXG4gICAgICAgIGluaXRpYXRlZDogbmV3IERhdGUodXBsb2FkLkluaXRpYXRlZCksXG4gICAgICB9XG4gICAgICBpZiAodXBsb2FkLkluaXRpYXRvcikge1xuICAgICAgICB1cGxvYWRJdGVtLmluaXRpYXRvciA9IHsgaWQ6IHVwbG9hZC5Jbml0aWF0b3IuSUQsIGRpc3BsYXlOYW1lOiB1cGxvYWQuSW5pdGlhdG9yLkRpc3BsYXlOYW1lIH1cbiAgICAgIH1cbiAgICAgIGlmICh1cGxvYWQuT3duZXIpIHtcbiAgICAgICAgdXBsb2FkSXRlbS5vd25lciA9IHsgaWQ6IHVwbG9hZC5Pd25lci5JRCwgZGlzcGxheU5hbWU6IHVwbG9hZC5Pd25lci5EaXNwbGF5TmFtZSB9XG4gICAgICB9XG4gICAgICByZXN1bHQudXBsb2Fkcy5wdXNoKHVwbG9hZEl0ZW0pXG4gICAgfSlcbiAgfVxuICByZXR1cm4gcmVzdWx0XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBwYXJzZU9iamVjdExvY2tDb25maWcoeG1sOiBzdHJpbmcpOiBPYmplY3RMb2NrSW5mbyB7XG4gIGNvbnN0IHhtbE9iaiA9IHBhcnNlWG1sKHhtbClcbiAgbGV0IGxvY2tDb25maWdSZXN1bHQgPSB7fSBhcyBPYmplY3RMb2NrSW5mb1xuICBpZiAoeG1sT2JqLk9iamVjdExvY2tDb25maWd1cmF0aW9uKSB7XG4gICAgbG9ja0NvbmZpZ1Jlc3VsdCA9IHtcbiAgICAgIG9iamVjdExvY2tFbmFibGVkOiB4bWxPYmouT2JqZWN0TG9ja0NvbmZpZ3VyYXRpb24uT2JqZWN0TG9ja0VuYWJsZWQsXG4gICAgfSBhcyBPYmplY3RMb2NrSW5mb1xuICAgIGxldCByZXRlbnRpb25SZXNwXG4gICAgaWYgKFxuICAgICAgeG1sT2JqLk9iamVjdExvY2tDb25maWd1cmF0aW9uICYmXG4gICAgICB4bWxPYmouT2JqZWN0TG9ja0NvbmZpZ3VyYXRpb24uUnVsZSAmJlxuICAgICAgeG1sT2JqLk9iamVjdExvY2tDb25maWd1cmF0aW9uLlJ1bGUuRGVmYXVsdFJldGVudGlvblxuICAgICkge1xuICAgICAgcmV0ZW50aW9uUmVzcCA9IHhtbE9iai5PYmplY3RMb2NrQ29uZmlndXJhdGlvbi5SdWxlLkRlZmF1bHRSZXRlbnRpb24gfHwge31cbiAgICAgIGxvY2tDb25maWdSZXN1bHQubW9kZSA9IHJldGVudGlvblJlc3AuTW9kZVxuICAgIH1cbiAgICBpZiAocmV0ZW50aW9uUmVzcCkge1xuICAgICAgY29uc3QgaXNVbml0WWVhcnMgPSByZXRlbnRpb25SZXNwLlllYXJzXG4gICAgICBpZiAoaXNVbml0WWVhcnMpIHtcbiAgICAgICAgbG9ja0NvbmZpZ1Jlc3VsdC52YWxpZGl0eSA9IGlzVW5pdFllYXJzXG4gICAgICAgIGxvY2tDb25maWdSZXN1bHQudW5pdCA9IFJFVEVOVElPTl9WQUxJRElUWV9VTklUUy5ZRUFSU1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgbG9ja0NvbmZpZ1Jlc3VsdC52YWxpZGl0eSA9IHJldGVudGlvblJlc3AuRGF5c1xuICAgICAgICBsb2NrQ29uZmlnUmVzdWx0LnVuaXQgPSBSRVRFTlRJT05fVkFMSURJVFlfVU5JVFMuREFZU1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIHJldHVybiBsb2NrQ29uZmlnUmVzdWx0XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBwYXJzZUJ1Y2tldFZlcnNpb25pbmdDb25maWcoeG1sOiBzdHJpbmcpIHtcbiAgY29uc3QgeG1sT2JqID0gcGFyc2VYbWwoeG1sKVxuICByZXR1cm4geG1sT2JqLlZlcnNpb25pbmdDb25maWd1cmF0aW9uXG59XG5cbi8vIFVzZWQgb25seSBpbiBzZWxlY3RPYmplY3RDb250ZW50IEFQSS5cbi8vIGV4dHJhY3RIZWFkZXJUeXBlIGV4dHJhY3RzIHRoZSBmaXJzdCBoYWxmIG9mIHRoZSBoZWFkZXIgbWVzc2FnZSwgdGhlIGhlYWRlciB0eXBlLlxuZnVuY3Rpb24gZXh0cmFjdEhlYWRlclR5cGUoc3RyZWFtOiBzdHJlYW0uUmVhZGFibGUpOiBzdHJpbmcgfCB1bmRlZmluZWQge1xuICBjb25zdCBoZWFkZXJOYW1lTGVuID0gQnVmZmVyLmZyb20oc3RyZWFtLnJlYWQoMSkpLnJlYWRVSW50OCgpXG4gIGNvbnN0IGhlYWRlck5hbWVXaXRoU2VwYXJhdG9yID0gQnVmZmVyLmZyb20oc3RyZWFtLnJlYWQoaGVhZGVyTmFtZUxlbikpLnRvU3RyaW5nKClcbiAgY29uc3Qgc3BsaXRCeVNlcGFyYXRvciA9IChoZWFkZXJOYW1lV2l0aFNlcGFyYXRvciB8fCAnJykuc3BsaXQoJzonKVxuICByZXR1cm4gc3BsaXRCeVNlcGFyYXRvci5sZW5ndGggPj0gMSA/IHNwbGl0QnlTZXBhcmF0b3JbMV0gOiAnJ1xufVxuXG5mdW5jdGlvbiBleHRyYWN0SGVhZGVyVmFsdWUoc3RyZWFtOiBzdHJlYW0uUmVhZGFibGUpIHtcbiAgY29uc3QgYm9keUxlbiA9IEJ1ZmZlci5mcm9tKHN0cmVhbS5yZWFkKDIpKS5yZWFkVUludDE2QkUoKVxuICByZXR1cm4gQnVmZmVyLmZyb20oc3RyZWFtLnJlYWQoYm9keUxlbikpLnRvU3RyaW5nKClcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHBhcnNlU2VsZWN0T2JqZWN0Q29udGVudFJlc3BvbnNlKHJlczogQnVmZmVyKSB7XG4gIGNvbnN0IHNlbGVjdFJlc3VsdHMgPSBuZXcgU2VsZWN0UmVzdWx0cyh7fSkgLy8gd2lsbCBiZSByZXR1cm5lZFxuXG4gIGNvbnN0IHJlc3BvbnNlU3RyZWFtID0gcmVhZGFibGVTdHJlYW0ocmVzKSAvLyBjb252ZXJ0IGJ5dGUgYXJyYXkgdG8gYSByZWFkYWJsZSByZXNwb25zZVN0cmVhbVxuICAvLyBAdHMtaWdub3JlXG4gIHdoaWxlIChyZXNwb25zZVN0cmVhbS5fcmVhZGFibGVTdGF0ZS5sZW5ndGgpIHtcbiAgICAvLyBUb3AgbGV2ZWwgcmVzcG9uc2VTdHJlYW0gcmVhZCB0cmFja2VyLlxuICAgIGxldCBtc2dDcmNBY2N1bXVsYXRvciAvLyBhY2N1bXVsYXRlIGZyb20gc3RhcnQgb2YgdGhlIG1lc3NhZ2UgdGlsbCB0aGUgbWVzc2FnZSBjcmMgc3RhcnQuXG5cbiAgICBjb25zdCB0b3RhbEJ5dGVMZW5ndGhCdWZmZXIgPSBCdWZmZXIuZnJvbShyZXNwb25zZVN0cmVhbS5yZWFkKDQpKVxuICAgIG1zZ0NyY0FjY3VtdWxhdG9yID0gY3JjMzIodG90YWxCeXRlTGVuZ3RoQnVmZmVyKVxuXG4gICAgY29uc3QgaGVhZGVyQnl0ZXNCdWZmZXIgPSBCdWZmZXIuZnJvbShyZXNwb25zZVN0cmVhbS5yZWFkKDQpKVxuICAgIG1zZ0NyY0FjY3VtdWxhdG9yID0gY3JjMzIoaGVhZGVyQnl0ZXNCdWZmZXIsIG1zZ0NyY0FjY3VtdWxhdG9yKVxuXG4gICAgY29uc3QgY2FsY3VsYXRlZFByZWx1ZGVDcmMgPSBtc2dDcmNBY2N1bXVsYXRvci5yZWFkSW50MzJCRSgpIC8vIHVzZSBpdCB0byBjaGVjayBpZiBhbnkgQ1JDIG1pc21hdGNoIGluIGhlYWRlciBpdHNlbGYuXG5cbiAgICBjb25zdCBwcmVsdWRlQ3JjQnVmZmVyID0gQnVmZmVyLmZyb20ocmVzcG9uc2VTdHJlYW0ucmVhZCg0KSkgLy8gcmVhZCA0IGJ5dGVzICAgIGkuZSA0KzQgPTggKyA0ID0gMTIgKCBwcmVsdWRlICsgcHJlbHVkZSBjcmMpXG4gICAgbXNnQ3JjQWNjdW11bGF0b3IgPSBjcmMzMihwcmVsdWRlQ3JjQnVmZmVyLCBtc2dDcmNBY2N1bXVsYXRvcilcblxuICAgIGNvbnN0IHRvdGFsTXNnTGVuZ3RoID0gdG90YWxCeXRlTGVuZ3RoQnVmZmVyLnJlYWRJbnQzMkJFKClcbiAgICBjb25zdCBoZWFkZXJMZW5ndGggPSBoZWFkZXJCeXRlc0J1ZmZlci5yZWFkSW50MzJCRSgpXG4gICAgY29uc3QgcHJlbHVkZUNyY0J5dGVWYWx1ZSA9IHByZWx1ZGVDcmNCdWZmZXIucmVhZEludDMyQkUoKVxuXG4gICAgaWYgKHByZWx1ZGVDcmNCeXRlVmFsdWUgIT09IGNhbGN1bGF0ZWRQcmVsdWRlQ3JjKSB7XG4gICAgICAvLyBIYW5kbGUgSGVhZGVyIENSQyBtaXNtYXRjaCBFcnJvclxuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBgSGVhZGVyIENoZWNrc3VtIE1pc21hdGNoLCBQcmVsdWRlIENSQyBvZiAke3ByZWx1ZGVDcmNCeXRlVmFsdWV9IGRvZXMgbm90IGVxdWFsIGV4cGVjdGVkIENSQyBvZiAke2NhbGN1bGF0ZWRQcmVsdWRlQ3JjfWAsXG4gICAgICApXG4gICAgfVxuXG4gICAgY29uc3QgaGVhZGVyczogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7fVxuICAgIGlmIChoZWFkZXJMZW5ndGggPiAwKSB7XG4gICAgICBjb25zdCBoZWFkZXJCeXRlcyA9IEJ1ZmZlci5mcm9tKHJlc3BvbnNlU3RyZWFtLnJlYWQoaGVhZGVyTGVuZ3RoKSlcbiAgICAgIG1zZ0NyY0FjY3VtdWxhdG9yID0gY3JjMzIoaGVhZGVyQnl0ZXMsIG1zZ0NyY0FjY3VtdWxhdG9yKVxuICAgICAgY29uc3QgaGVhZGVyUmVhZGVyU3RyZWFtID0gcmVhZGFibGVTdHJlYW0oaGVhZGVyQnl0ZXMpXG4gICAgICAvLyBAdHMtaWdub3JlXG4gICAgICB3aGlsZSAoaGVhZGVyUmVhZGVyU3RyZWFtLl9yZWFkYWJsZVN0YXRlLmxlbmd0aCkge1xuICAgICAgICBjb25zdCBoZWFkZXJUeXBlTmFtZSA9IGV4dHJhY3RIZWFkZXJUeXBlKGhlYWRlclJlYWRlclN0cmVhbSlcbiAgICAgICAgaGVhZGVyUmVhZGVyU3RyZWFtLnJlYWQoMSkgLy8ganVzdCByZWFkIGFuZCBpZ25vcmUgaXQuXG4gICAgICAgIGlmIChoZWFkZXJUeXBlTmFtZSkge1xuICAgICAgICAgIGhlYWRlcnNbaGVhZGVyVHlwZU5hbWVdID0gZXh0cmFjdEhlYWRlclZhbHVlKGhlYWRlclJlYWRlclN0cmVhbSlcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cblxuICAgIGxldCBwYXlsb2FkU3RyZWFtXG4gICAgY29uc3QgcGF5TG9hZExlbmd0aCA9IHRvdGFsTXNnTGVuZ3RoIC0gaGVhZGVyTGVuZ3RoIC0gMTZcbiAgICBpZiAocGF5TG9hZExlbmd0aCA+IDApIHtcbiAgICAgIGNvbnN0IHBheUxvYWRCdWZmZXIgPSBCdWZmZXIuZnJvbShyZXNwb25zZVN0cmVhbS5yZWFkKHBheUxvYWRMZW5ndGgpKVxuICAgICAgbXNnQ3JjQWNjdW11bGF0b3IgPSBjcmMzMihwYXlMb2FkQnVmZmVyLCBtc2dDcmNBY2N1bXVsYXRvcilcbiAgICAgIC8vIHJlYWQgdGhlIGNoZWNrc3VtIGVhcmx5IGFuZCBkZXRlY3QgYW55IG1pc21hdGNoIHNvIHdlIGNhbiBhdm9pZCB1bm5lY2Vzc2FyeSBmdXJ0aGVyIHByb2Nlc3NpbmcuXG4gICAgICBjb25zdCBtZXNzYWdlQ3JjQnl0ZVZhbHVlID0gQnVmZmVyLmZyb20ocmVzcG9uc2VTdHJlYW0ucmVhZCg0KSkucmVhZEludDMyQkUoKVxuICAgICAgY29uc3QgY2FsY3VsYXRlZENyYyA9IG1zZ0NyY0FjY3VtdWxhdG9yLnJlYWRJbnQzMkJFKClcbiAgICAgIC8vIEhhbmRsZSBtZXNzYWdlIENSQyBFcnJvclxuICAgICAgaWYgKG1lc3NhZ2VDcmNCeXRlVmFsdWUgIT09IGNhbGN1bGF0ZWRDcmMpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAgIGBNZXNzYWdlIENoZWNrc3VtIE1pc21hdGNoLCBNZXNzYWdlIENSQyBvZiAke21lc3NhZ2VDcmNCeXRlVmFsdWV9IGRvZXMgbm90IGVxdWFsIGV4cGVjdGVkIENSQyBvZiAke2NhbGN1bGF0ZWRDcmN9YCxcbiAgICAgICAgKVxuICAgICAgfVxuICAgICAgcGF5bG9hZFN0cmVhbSA9IHJlYWRhYmxlU3RyZWFtKHBheUxvYWRCdWZmZXIpXG4gICAgfVxuICAgIGNvbnN0IG1lc3NhZ2VUeXBlID0gaGVhZGVyc1snbWVzc2FnZS10eXBlJ11cblxuICAgIHN3aXRjaCAobWVzc2FnZVR5cGUpIHtcbiAgICAgIGNhc2UgJ2Vycm9yJzoge1xuICAgICAgICBjb25zdCBlcnJvck1lc3NhZ2UgPSBoZWFkZXJzWydlcnJvci1jb2RlJ10gKyAnOlwiJyArIGhlYWRlcnNbJ2Vycm9yLW1lc3NhZ2UnXSArICdcIidcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGVycm9yTWVzc2FnZSlcbiAgICAgIH1cbiAgICAgIGNhc2UgJ2V2ZW50Jzoge1xuICAgICAgICBjb25zdCBjb250ZW50VHlwZSA9IGhlYWRlcnNbJ2NvbnRlbnQtdHlwZSddXG4gICAgICAgIGNvbnN0IGV2ZW50VHlwZSA9IGhlYWRlcnNbJ2V2ZW50LXR5cGUnXVxuXG4gICAgICAgIHN3aXRjaCAoZXZlbnRUeXBlKSB7XG4gICAgICAgICAgY2FzZSAnRW5kJzoge1xuICAgICAgICAgICAgc2VsZWN0UmVzdWx0cy5zZXRSZXNwb25zZShyZXMpXG4gICAgICAgICAgICByZXR1cm4gc2VsZWN0UmVzdWx0c1xuICAgICAgICAgIH1cblxuICAgICAgICAgIGNhc2UgJ1JlY29yZHMnOiB7XG4gICAgICAgICAgICBjb25zdCByZWFkRGF0YSA9IHBheWxvYWRTdHJlYW0/LnJlYWQocGF5TG9hZExlbmd0aClcbiAgICAgICAgICAgIHNlbGVjdFJlc3VsdHMuc2V0UmVjb3JkcyhyZWFkRGF0YSlcbiAgICAgICAgICAgIGJyZWFrXG4gICAgICAgICAgfVxuXG4gICAgICAgICAgY2FzZSAnUHJvZ3Jlc3MnOlxuICAgICAgICAgICAge1xuICAgICAgICAgICAgICBzd2l0Y2ggKGNvbnRlbnRUeXBlKSB7XG4gICAgICAgICAgICAgICAgY2FzZSAndGV4dC94bWwnOiB7XG4gICAgICAgICAgICAgICAgICBjb25zdCBwcm9ncmVzc0RhdGEgPSBwYXlsb2FkU3RyZWFtPy5yZWFkKHBheUxvYWRMZW5ndGgpXG4gICAgICAgICAgICAgICAgICBzZWxlY3RSZXN1bHRzLnNldFByb2dyZXNzKHByb2dyZXNzRGF0YS50b1N0cmluZygpKVxuICAgICAgICAgICAgICAgICAgYnJlYWtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgZGVmYXVsdDoge1xuICAgICAgICAgICAgICAgICAgY29uc3QgZXJyb3JNZXNzYWdlID0gYFVuZXhwZWN0ZWQgY29udGVudC10eXBlICR7Y29udGVudFR5cGV9IHNlbnQgZm9yIGV2ZW50LXR5cGUgUHJvZ3Jlc3NgXG4gICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoZXJyb3JNZXNzYWdlKVxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICAgICAgYnJlYWtcbiAgICAgICAgICBjYXNlICdTdGF0cyc6XG4gICAgICAgICAgICB7XG4gICAgICAgICAgICAgIHN3aXRjaCAoY29udGVudFR5cGUpIHtcbiAgICAgICAgICAgICAgICBjYXNlICd0ZXh0L3htbCc6IHtcbiAgICAgICAgICAgICAgICAgIGNvbnN0IHN0YXRzRGF0YSA9IHBheWxvYWRTdHJlYW0/LnJlYWQocGF5TG9hZExlbmd0aClcbiAgICAgICAgICAgICAgICAgIHNlbGVjdFJlc3VsdHMuc2V0U3RhdHMoc3RhdHNEYXRhLnRvU3RyaW5nKCkpXG4gICAgICAgICAgICAgICAgICBicmVha1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBkZWZhdWx0OiB7XG4gICAgICAgICAgICAgICAgICBjb25zdCBlcnJvck1lc3NhZ2UgPSBgVW5leHBlY3RlZCBjb250ZW50LXR5cGUgJHtjb250ZW50VHlwZX0gc2VudCBmb3IgZXZlbnQtdHlwZSBTdGF0c2BcbiAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihlcnJvck1lc3NhZ2UpXG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBicmVha1xuICAgICAgICAgIGRlZmF1bHQ6IHtcbiAgICAgICAgICAgIC8vIENvbnRpbnVhdGlvbiBtZXNzYWdlOiBOb3Qgc3VyZSBpZiBpdCBpcyBzdXBwb3J0ZWQuIGRpZCBub3QgZmluZCBhIHJlZmVyZW5jZSBvciBhbnkgbWVzc2FnZSBpbiByZXNwb25zZS5cbiAgICAgICAgICAgIC8vIEl0IGRvZXMgbm90IGhhdmUgYSBwYXlsb2FkLlxuICAgICAgICAgICAgY29uc3Qgd2FybmluZ01lc3NhZ2UgPSBgVW4gaW1wbGVtZW50ZWQgZXZlbnQgZGV0ZWN0ZWQgICR7bWVzc2FnZVR5cGV9LmBcbiAgICAgICAgICAgIC8vIGVzbGludC1kaXNhYmxlLW5leHQtbGluZSBuby1jb25zb2xlXG4gICAgICAgICAgICBjb25zb2xlLndhcm4od2FybmluZ01lc3NhZ2UpXG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuICB9XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBwYXJzZUxpZmVjeWNsZUNvbmZpZyh4bWw6IHN0cmluZykge1xuICBjb25zdCB4bWxPYmogPSBwYXJzZVhtbCh4bWwpXG4gIHJldHVybiB4bWxPYmouTGlmZWN5Y2xlQ29uZmlndXJhdGlvblxufVxuXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VCdWNrZXRFbmNyeXB0aW9uQ29uZmlnKHhtbDogc3RyaW5nKSB7XG4gIHJldHVybiBwYXJzZVhtbCh4bWwpXG59XG5cbmV4cG9ydCBmdW5jdGlvbiBwYXJzZU9iamVjdFJldGVudGlvbkNvbmZpZyh4bWw6IHN0cmluZykge1xuICBjb25zdCB4bWxPYmogPSBwYXJzZVhtbCh4bWwpXG4gIGNvbnN0IHJldGVudGlvbkNvbmZpZyA9IHhtbE9iai5SZXRlbnRpb25cbiAgcmV0dXJuIHtcbiAgICBtb2RlOiByZXRlbnRpb25Db25maWcuTW9kZSxcbiAgICByZXRhaW5VbnRpbERhdGU6IHJldGVudGlvbkNvbmZpZy5SZXRhaW5VbnRpbERhdGUsXG4gIH1cbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHJlbW92ZU9iamVjdHNQYXJzZXIoeG1sOiBzdHJpbmcpIHtcbiAgY29uc3QgeG1sT2JqID0gcGFyc2VYbWwoeG1sKVxuICBpZiAoeG1sT2JqLkRlbGV0ZVJlc3VsdCAmJiB4bWxPYmouRGVsZXRlUmVzdWx0LkVycm9yKSB7XG4gICAgLy8gcmV0dXJuIGVycm9ycyBhcyBhcnJheSBhbHdheXMuIGFzIHRoZSByZXNwb25zZSBpcyBvYmplY3QgaW4gY2FzZSBvZiBzaW5nbGUgb2JqZWN0IHBhc3NlZCBpbiByZW1vdmVPYmplY3RzXG4gICAgcmV0dXJuIHRvQXJyYXkoeG1sT2JqLkRlbGV0ZVJlc3VsdC5FcnJvcilcbiAgfVxuICByZXR1cm4gW11cbn1cblxuLy8gcGFyc2UgWE1MIHJlc3BvbnNlIGZvciBjb3B5IG9iamVjdFxuZXhwb3J0IGZ1bmN0aW9uIHBhcnNlQ29weU9iamVjdCh4bWw6IHN0cmluZyk6IENvcHlPYmplY3RSZXN1bHRWMSB7XG4gIGNvbnN0IHJlc3VsdDogQ29weU9iamVjdFJlc3VsdFYxID0ge1xuICAgIGV0YWc6ICcnLFxuICAgIGxhc3RNb2RpZmllZDogJycsXG4gIH1cblxuICBsZXQgeG1sb2JqID0gcGFyc2VYbWwoeG1sKVxuICBpZiAoIXhtbG9iai5Db3B5T2JqZWN0UmVzdWx0KSB7XG4gICAgdGhyb3cgbmV3IGVycm9ycy5JbnZhbGlkWE1MRXJyb3IoJ01pc3NpbmcgdGFnOiBcIkNvcHlPYmplY3RSZXN1bHRcIicpXG4gIH1cbiAgeG1sb2JqID0geG1sb2JqLkNvcHlPYmplY3RSZXN1bHRcbiAgaWYgKHhtbG9iai5FVGFnKSB7XG4gICAgcmVzdWx0LmV0YWcgPSB4bWxvYmouRVRhZy5yZXBsYWNlKC9eXCIvZywgJycpXG4gICAgICAucmVwbGFjZSgvXCIkL2csICcnKVxuICAgICAgLnJlcGxhY2UoL14mcXVvdDsvZywgJycpXG4gICAgICAucmVwbGFjZSgvJnF1b3Q7JC9nLCAnJylcbiAgICAgIC5yZXBsYWNlKC9eJiMzNDsvZywgJycpXG4gICAgICAucmVwbGFjZSgvJiMzNDskL2csICcnKVxuICB9XG4gIGlmICh4bWxvYmouTGFzdE1vZGlmaWVkKSB7XG4gICAgcmVzdWx0Lmxhc3RNb2RpZmllZCA9IG5ldyBEYXRlKHhtbG9iai5MYXN0TW9kaWZpZWQpXG4gIH1cblxuICByZXR1cm4gcmVzdWx0XG59XG5cbmNvbnN0IGZvcm1hdE9iakluZm8gPSAoY29udGVudDogT2JqZWN0Um93RW50cnksIG9wdHM6IHsgSXNEZWxldGVNYXJrZXI/OiBib29sZWFuIH0gPSB7fSkgPT4ge1xuICBjb25zdCB7IEtleSwgTGFzdE1vZGlmaWVkLCBFVGFnLCBTaXplLCBWZXJzaW9uSWQsIElzTGF0ZXN0IH0gPSBjb250ZW50XG5cbiAgaWYgKCFpc09iamVjdChvcHRzKSkge1xuICAgIG9wdHMgPSB7fVxuICB9XG5cbiAgY29uc3QgbmFtZSA9IHNhbml0aXplT2JqZWN0S2V5KHRvQXJyYXkoS2V5KVswXSB8fCAnJylcbiAgY29uc3QgbGFzdE1vZGlmaWVkID0gTGFzdE1vZGlmaWVkID8gbmV3IERhdGUodG9BcnJheShMYXN0TW9kaWZpZWQpWzBdIHx8ICcnKSA6IHVuZGVmaW5lZFxuICBjb25zdCBldGFnID0gc2FuaXRpemVFVGFnKHRvQXJyYXkoRVRhZylbMF0gfHwgJycpXG4gIGNvbnN0IHNpemUgPSBzYW5pdGl6ZVNpemUoU2l6ZSB8fCAnJylcblxuICByZXR1cm4ge1xuICAgIG5hbWUsXG4gICAgbGFzdE1vZGlmaWVkLFxuICAgIGV0YWcsXG4gICAgc2l6ZSxcbiAgICB2ZXJzaW9uSWQ6IFZlcnNpb25JZCxcbiAgICBpc0xhdGVzdDogSXNMYXRlc3QsXG4gICAgaXNEZWxldGVNYXJrZXI6IG9wdHMuSXNEZWxldGVNYXJrZXIgPyBvcHRzLklzRGVsZXRlTWFya2VyIDogZmFsc2UsXG4gIH1cbn1cblxuLy8gcGFyc2UgWE1MIHJlc3BvbnNlIGZvciBsaXN0IG9iamVjdHMgaW4gYSBidWNrZXRcbmV4cG9ydCBmdW5jdGlvbiBwYXJzZUxpc3RPYmplY3RzKHhtbDogc3RyaW5nKSB7XG4gIGNvbnN0IHJlc3VsdDoge1xuICAgIG9iamVjdHM6IE9iamVjdEluZm9bXVxuICAgIGlzVHJ1bmNhdGVkPzogYm9vbGVhblxuICAgIG5leHRNYXJrZXI/OiBzdHJpbmdcbiAgICB2ZXJzaW9uSWRNYXJrZXI/OiBzdHJpbmdcbiAgICBrZXlNYXJrZXI/OiBzdHJpbmdcbiAgfSA9IHtcbiAgICBvYmplY3RzOiBbXSxcbiAgICBpc1RydW5jYXRlZDogZmFsc2UsXG4gICAgbmV4dE1hcmtlcjogdW5kZWZpbmVkLFxuICAgIHZlcnNpb25JZE1hcmtlcjogdW5kZWZpbmVkLFxuICAgIGtleU1hcmtlcjogdW5kZWZpbmVkLFxuICB9XG4gIGxldCBpc1RydW5jYXRlZCA9IGZhbHNlXG4gIGxldCBuZXh0TWFya2VyXG4gIGNvbnN0IHhtbG9iaiA9IGZ4cFdpdGhvdXROdW1QYXJzZXIucGFyc2UoeG1sKVxuXG4gIGNvbnN0IHBhcnNlQ29tbW9uUHJlZml4ZXNFbnRpdHkgPSAoY29tbW9uUHJlZml4RW50cnk6IENvbW1vblByZWZpeFtdKSA9PiB7XG4gICAgaWYgKGNvbW1vblByZWZpeEVudHJ5KSB7XG4gICAgICB0b0FycmF5KGNvbW1vblByZWZpeEVudHJ5KS5mb3JFYWNoKChjb21tb25QcmVmaXgpID0+IHtcbiAgICAgICAgcmVzdWx0Lm9iamVjdHMucHVzaCh7IHByZWZpeDogc2FuaXRpemVPYmplY3RLZXkodG9BcnJheShjb21tb25QcmVmaXguUHJlZml4KVswXSB8fCAnJyksIHNpemU6IDAgfSlcbiAgICAgIH0pXG4gICAgfVxuICB9XG5cbiAgY29uc3QgbGlzdEJ1Y2tldFJlc3VsdDogTGlzdEJ1Y2tldFJlc3VsdFYxID0geG1sb2JqLkxpc3RCdWNrZXRSZXN1bHRcbiAgY29uc3QgbGlzdFZlcnNpb25zUmVzdWx0OiBMaXN0QnVja2V0UmVzdWx0VjEgPSB4bWxvYmouTGlzdFZlcnNpb25zUmVzdWx0XG5cbiAgaWYgKGxpc3RCdWNrZXRSZXN1bHQpIHtcbiAgICBpZiAobGlzdEJ1Y2tldFJlc3VsdC5Jc1RydW5jYXRlZCkge1xuICAgICAgaXNUcnVuY2F0ZWQgPSBsaXN0QnVja2V0UmVzdWx0LklzVHJ1bmNhdGVkXG4gICAgfVxuICAgIGlmIChsaXN0QnVja2V0UmVzdWx0LkNvbnRlbnRzKSB7XG4gICAgICB0b0FycmF5KGxpc3RCdWNrZXRSZXN1bHQuQ29udGVudHMpLmZvckVhY2goKGNvbnRlbnQpID0+IHtcbiAgICAgICAgY29uc3QgbmFtZSA9IHNhbml0aXplT2JqZWN0S2V5KHRvQXJyYXkoY29udGVudC5LZXkpWzBdIHx8ICcnKVxuICAgICAgICBjb25zdCBsYXN0TW9kaWZpZWQgPSBuZXcgRGF0ZSh0b0FycmF5KGNvbnRlbnQuTGFzdE1vZGlmaWVkKVswXSB8fCAnJylcbiAgICAgICAgY29uc3QgZXRhZyA9IHNhbml0aXplRVRhZyh0b0FycmF5KGNvbnRlbnQuRVRhZylbMF0gfHwgJycpXG4gICAgICAgIGNvbnN0IHNpemUgPSBzYW5pdGl6ZVNpemUoY29udGVudC5TaXplIHx8ICcnKVxuICAgICAgICByZXN1bHQub2JqZWN0cy5wdXNoKHsgbmFtZSwgbGFzdE1vZGlmaWVkLCBldGFnLCBzaXplIH0pXG4gICAgICB9KVxuICAgIH1cblxuICAgIGlmIChsaXN0QnVja2V0UmVzdWx0Lk1hcmtlcikge1xuICAgICAgbmV4dE1hcmtlciA9IGxpc3RCdWNrZXRSZXN1bHQuTWFya2VyXG4gICAgfVxuICAgIGlmIChsaXN0QnVja2V0UmVzdWx0Lk5leHRNYXJrZXIpIHtcbiAgICAgIG5leHRNYXJrZXIgPSBsaXN0QnVja2V0UmVzdWx0Lk5leHRNYXJrZXJcbiAgICB9IGVsc2UgaWYgKGlzVHJ1bmNhdGVkICYmIHJlc3VsdC5vYmplY3RzLmxlbmd0aCA+IDApIHtcbiAgICAgIG5leHRNYXJrZXIgPSByZXN1bHQub2JqZWN0c1tyZXN1bHQub2JqZWN0cy5sZW5ndGggLSAxXT8ubmFtZVxuICAgIH1cbiAgICBpZiAobGlzdEJ1Y2tldFJlc3VsdC5Db21tb25QcmVmaXhlcykge1xuICAgICAgcGFyc2VDb21tb25QcmVmaXhlc0VudGl0eShsaXN0QnVja2V0UmVzdWx0LkNvbW1vblByZWZpeGVzKVxuICAgIH1cbiAgfVxuXG4gIGlmIChsaXN0VmVyc2lvbnNSZXN1bHQpIHtcbiAgICBpZiAobGlzdFZlcnNpb25zUmVzdWx0LklzVHJ1bmNhdGVkKSB7XG4gICAgICBpc1RydW5jYXRlZCA9IGxpc3RWZXJzaW9uc1Jlc3VsdC5Jc1RydW5jYXRlZFxuICAgIH1cblxuICAgIGlmIChsaXN0VmVyc2lvbnNSZXN1bHQuVmVyc2lvbikge1xuICAgICAgdG9BcnJheShsaXN0VmVyc2lvbnNSZXN1bHQuVmVyc2lvbikuZm9yRWFjaCgoY29udGVudCkgPT4ge1xuICAgICAgICByZXN1bHQub2JqZWN0cy5wdXNoKGZvcm1hdE9iakluZm8oY29udGVudCkpXG4gICAgICB9KVxuICAgIH1cbiAgICBpZiAobGlzdFZlcnNpb25zUmVzdWx0LkRlbGV0ZU1hcmtlcikge1xuICAgICAgdG9BcnJheShsaXN0VmVyc2lvbnNSZXN1bHQuRGVsZXRlTWFya2VyKS5mb3JFYWNoKChjb250ZW50KSA9PiB7XG4gICAgICAgIHJlc3VsdC5vYmplY3RzLnB1c2goZm9ybWF0T2JqSW5mbyhjb250ZW50LCB7IElzRGVsZXRlTWFya2VyOiB0cnVlIH0pKVxuICAgICAgfSlcbiAgICB9XG5cbiAgICBpZiAobGlzdFZlcnNpb25zUmVzdWx0Lk5leHRLZXlNYXJrZXIpIHtcbiAgICAgIHJlc3VsdC5rZXlNYXJrZXIgPSBsaXN0VmVyc2lvbnNSZXN1bHQuTmV4dEtleU1hcmtlclxuICAgIH1cbiAgICBpZiAobGlzdFZlcnNpb25zUmVzdWx0Lk5leHRWZXJzaW9uSWRNYXJrZXIpIHtcbiAgICAgIHJlc3VsdC52ZXJzaW9uSWRNYXJrZXIgPSBsaXN0VmVyc2lvbnNSZXN1bHQuTmV4dFZlcnNpb25JZE1hcmtlclxuICAgIH1cbiAgICBpZiAobGlzdFZlcnNpb25zUmVzdWx0LkNvbW1vblByZWZpeGVzKSB7XG4gICAgICBwYXJzZUNvbW1vblByZWZpeGVzRW50aXR5KGxpc3RWZXJzaW9uc1Jlc3VsdC5Db21tb25QcmVmaXhlcylcbiAgICB9XG4gIH1cblxuICByZXN1bHQuaXNUcnVuY2F0ZWQgPSBpc1RydW5jYXRlZFxuICBpZiAoaXNUcnVuY2F0ZWQpIHtcbiAgICByZXN1bHQubmV4dE1hcmtlciA9IG5leHRNYXJrZXJcbiAgfVxuICByZXR1cm4gcmVzdWx0XG59XG5cbmV4cG9ydCBmdW5jdGlvbiB1cGxvYWRQYXJ0UGFyc2VyKHhtbDogc3RyaW5nKSB7XG4gIGNvbnN0IHhtbE9iaiA9IHBhcnNlWG1sKHhtbClcbiAgY29uc3QgcmVzcEVsID0geG1sT2JqLkNvcHlQYXJ0UmVzdWx0XG4gIHJldHVybiByZXNwRWxcbn1cbiJdLCJtYXBwaW5ncyI6IkFBR0EsT0FBT0EsS0FBSyxNQUFNLGNBQWM7QUFDaEMsU0FBU0MsU0FBUyxRQUFRLGlC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