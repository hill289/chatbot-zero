'use strict';
// ══════════════════════════════════════════════════════════════════
//  pglite-server：Postgres Wire Protocol TCP 服务（把客户端请求转发给 PGlite）
//  移植自参考项目 pglite-server-master/src（MIT, Kamil Ogórek），TS/ESM → CommonJS：
//    server.ts      → createServer()
//    messages.ts    → parseMessage()
//    responses.ts   → createMessageResponse()
//    write-buffer.ts→ GrowableOffsetBuffer()
//    logger.ts      → LogLevel / Logger
//  行为（与参考项目一致）：
//    · 拦截 SSLRequest / GSSENCRequest / StartupMessage / CancelRequest，
//      伪造认证流程（AuthOk + ParameterStatus + BackendKeyData + ReadyForQuery）
//    · 其余前端消息原样交给 PGlite 的 execProtocol 处理
//  文档：
//    https://www.postgresql.org/docs/current/protocol.html
//    https://www.postgresql.org/docs/current/protocol-message-formats.html
// ══════════════════════════════════════════════════════════════════
const net = require('node:net');

// ── logger.ts ────────────────────────────────────────────────────
const LogLevel = Object.freeze({ Error: 0, Warn: 1, Info: 2, Debug: 3 });

class Logger {
  constructor(logLevel = LogLevel.Info, prefix = '') {
    this.logLevel = logLevel;
    this.prefix = `[pglite ${prefix}]:`;
  }

  debug(...data) {
    if (this.logLevel < LogLevel.Debug) return;
    console.debug(this.prefix, ...data);
  }

  info(...data) {
    if (this.logLevel < LogLevel.Info) return;
    console.info(this.prefix, ...data);
  }

  warn(...data) {
    if (this.logLevel < LogLevel.Warn) return;
    console.warn(this.prefix, ...data);
  }

  error(...data) {
    console.error(this.prefix, ...data);
  }
}

// ── write-buffer.ts ──────────────────────────────────────────────
// 可增长的字节缓冲（按偏移写入），用于拼协议响应包。
class GrowableOffsetBuffer {
  #buffer = Buffer.alloc(16);
  #offset = 0;

  write(data) {
    const byteLength = Buffer.byteLength(data);
    this.updateCapacity(byteLength);
    this.#buffer.write(data, this.#offset);
    this.#offset += byteLength;
  }

  writeUint8(data) {
    this.updateCapacity(1);
    this.#buffer.writeUint8(data, this.#offset);
    this.#offset += 1;
  }

  writeUint32BE(data) {
    this.updateCapacity(4);
    this.#buffer.writeUint32BE(data, this.#offset);
    this.#offset += 4;
  }

  updateCapacity(chunkLength) {
    while (this.#buffer.byteLength < this.#offset + chunkLength) {
      const newBuffer = Buffer.alloc(this.#buffer.byteLength * 2);
      this.#buffer.copy(newBuffer, 0, 0, this.#offset);
      this.#buffer = newBuffer;
    }
  }

  toBuffer() {
    return Buffer.from(this.#buffer.subarray(0, this.#offset));
  }
}

// ── messages.ts ──────────────────────────────────────────────────
const IDENT_LENGTH = 1;

const IDENT_TO_MESSAGE_NAME = {
  B: 'Bind',
  C: 'Close',
  f: 'CopyFail',
  D: 'Describe',
  E: 'Execute',
  H: 'Flush',
  F: 'FunctionCall',
  P: 'Parse',
  // 0x70 同时是 PasswordMessage / GSSResponse / SASLResponse，靠标识符无法区分
  p: 'PasswordMessage',
  Q: 'Query',
  S: 'Sync',
  X: 'Terminate',
};

// map 的键统一转成 charCode（上面写成字符更可读，这里做一次展开）
const IDENT_CODE_TO_MESSAGE_NAME = Object.freeze(
  Object.fromEntries(
    Object.entries(IDENT_TO_MESSAGE_NAME).map(([ch, name]) => [ch.charCodeAt(0), name])
  )
);

const UNKNOWN_MESSAGE = { name: 'Unknown', length: 0, buffer: Buffer.alloc(0) };
const INSUFFICIENT_DATA = { name: 'InsufficientData', length: 0, buffer: Buffer.alloc(0) };

// 1234 5678 —— CancelRequest
function isCancelRequest(buffer) {
  return (
    buffer.at(4) === 0x04 &&
    buffer.at(5) === 0xd2 &&
    buffer.at(6) === 0x16 &&
    buffer.at(7) === 0x2e
  );
}

// 1234 5680 —— GSSENCRequest
function isGSSENCRequest(buffer) {
  return (
    buffer.at(4) === 0x04 &&
    buffer.at(5) === 0xd2 &&
    buffer.at(6) === 0x16 &&
    buffer.at(7) === 0x30
  );
}

// 1234 5679 —— SSLRequest
function isSSLRequest(buffer) {
  return (
    buffer.at(4) === 0x04 &&
    buffer.at(5) === 0xd2 &&
    buffer.at(6) === 0x16 &&
    buffer.at(7) === 0x2f
  );
}

// 0003 0000 —— StartupMessage（协议 3.0）
function isStartupMessage(buffer) {
  return (
    buffer.at(4) === 0x00 &&
    buffer.at(5) === 0x03 &&
    buffer.at(6) === 0x00 &&
    buffer.at(7) === 0x00
  );
}

// 从缓冲区头部解析一条前端消息；数据不够时返回 InsufficientData（等下一批包）
function parseMessage(buffer) {
  if (buffer.length < 5) {
    return INSUFFICIENT_DATA;
  }

  // 无标识符的消息（Cancel/GSS/SSL/Startup）至少要 8 字节（4 长度 + 4 魔数）
  if (buffer.length >= 8) {
    let unidentifiedName = null;
    if (isCancelRequest(buffer)) unidentifiedName = 'CancelRequest';
    else if (isGSSENCRequest(buffer)) unidentifiedName = 'GSSENCRequest';
    else if (isSSLRequest(buffer)) unidentifiedName = 'SSLRequest';
    else if (isStartupMessage(buffer)) unidentifiedName = 'StartupMessage';

    if (unidentifiedName) {
      const length = buffer.readUint32BE(0);
      if (buffer.length < length) return INSUFFICIENT_DATA;
      return { name: unidentifiedName, length, buffer: Buffer.from(buffer.subarray(0, length)) };
    }
  }

  // 带标识符的消息至少要 5 字节（1 标识符 + 4 长度）
  const name = IDENT_CODE_TO_MESSAGE_NAME[buffer.at(0)];
  if (!name) {
    // 还不够 8 字节时，它仍可能是 SSLRequest/StartupMessage 的半截包
    if (buffer.length < 8) return INSUFFICIENT_DATA;
    return UNKNOWN_MESSAGE;
  }

  const length = buffer.readUint32BE(1) + IDENT_LENGTH;
  if (buffer.length < length) return INSUFFICIENT_DATA;

  return { name, length, buffer: Buffer.from(buffer.subarray(0, length)) };
}

// ── responses.ts ─────────────────────────────────────────────────
// https://www.postgresql.org/docs/current/protocol-flow.html#PROTOCOL-FLOW-GSSAPI-ENCRYPTION
const GSSENC_REQUEST_RESPONSE = Buffer.from('N');

// https://www.postgresql.org/docs/current/protocol-flow.html#PROTOCOL-FLOW-SSL
const SSL_REQUEST_RESPONSE = Buffer.from('N');

// 启动应答：AuthenticationOk + ParameterStatus + BackendKeyData + ReadyForQuery
const STARTUP_MESSAGE_RESPONSE = buildStartupMessageResponse();

function buildStartupMessageResponse() {
  // AuthenticationOk
  const authOk = new GrowableOffsetBuffer();
  authOk.write('R');
  authOk.writeUint32BE(8);
  authOk.writeUint32BE(0);

  // ParameterStatus：DBeaver/DataGrip 等工具要求启动期收到 server_version，
  // 值本身不重要（真正 SHOW server_version 会转给底层 execProtocol）
  const parameterStatus = new GrowableOffsetBuffer();
  const paramKey = 'server_version';
  const paramValue = 'pglite';
  parameterStatus.write('S');
  parameterStatus.writeUint32BE(6 + Buffer.byteLength(paramKey) + Buffer.byteLength(paramValue));
  parameterStatus.write(paramKey);
  parameterStatus.writeUint8(0);
  parameterStatus.write(paramValue);
  parameterStatus.writeUint8(0);

  // BackendKeyData（伪造的 pid/key，CancelRequest 由本服务直接忽略）
  const backendKeyData = new GrowableOffsetBuffer();
  backendKeyData.write('K');
  backendKeyData.writeUint32BE(12);
  backendKeyData.writeUint32BE(1);
  backendKeyData.writeUint32BE(2);

  // ReadyForQuery（I = idle）
  const readyForQuery = new GrowableOffsetBuffer();
  readyForQuery.write('Z');
  readyForQuery.writeUint32BE(5);
  readyForQuery.write('I');

  return Buffer.concat([
    authOk.toBuffer(),
    parameterStatus.toBuffer(),
    backendKeyData.toBuffer(),
    readyForQuery.toBuffer(),
  ]);
}

// 出错时：ErrorResponse 后面必须跟 ReadyForQuery
function createErrorResponse(message) {
  const errorResponse = new GrowableOffsetBuffer();
  errorResponse.write('E');
  errorResponse.writeUint32BE(7 + Buffer.byteLength(message));
  errorResponse.write('M');
  errorResponse.write(message);
  errorResponse.writeUint8(0);
  errorResponse.writeUint8(0);

  const readyForQuery = new GrowableOffsetBuffer();
  readyForQuery.write('Z');
  readyForQuery.writeUint32BE(5);
  readyForQuery.write('I');

  return Buffer.concat([errorResponse.toBuffer(), readyForQuery.toBuffer()]);
}

// 一条前端消息 → 后端响应字节（null = 直接结束连接）
async function createMessageResponse(message, db) {
  switch (message.name) {
    // CancelRequest 走独立连接且无应答，收到即关连接
    case 'CancelRequest':
      return null;
    case 'GSSENCRequest':
      return GSSENC_REQUEST_RESPONSE;
    case 'SSLRequest':
      return SSL_REQUEST_RESPONSE;
    case 'StartupMessage':
      return STARTUP_MESSAGE_RESPONSE;
    default:
      try {
        const result = await db.execProtocol(message.buffer);
        return Buffer.from(result.data);
      } catch (e) {
        const errorMessage = e instanceof Error ? e.message : 'Unknown error message';
        return createErrorResponse(errorMessage);
      }
  }
}

// ── server.ts ────────────────────────────────────────────────────
async function processBuffer(clientBuffer, socket, db, logger) {
  while (clientBuffer.length > 0) {
    const message = parseMessage(clientBuffer);

    logger.debug(`${'-'.repeat(42)}\n`);
    logger.debug(`> Current buffer`);
    logger.debug(`> Length: ${clientBuffer.length}`);
    logger.debug(`> Raw:`, clientBuffer);
    logger.debug(`> Text: ${clientBuffer.toString()}`);
    logger.debug(``);
    logger.debug(`>> Message name: ${message.name}`);
    logger.debug(`>> Message length: ${message.length}`);
    logger.debug(`>> Message buffer raw:`, message.buffer);
    logger.debug(`>> Message buffer text: ${message.buffer.toString()}`);
    logger.debug(``);

    if (message.name === 'InsufficientData') break;

    if (message.name === 'Unknown' || message.name === 'Terminate') {
      socket.end();
      return clientBuffer;
    }

    const response = await createMessageResponse(message, db);
    if (response === null) {
      socket.end();
      return clientBuffer;
    }
    socket.write(response);
    clientBuffer = Buffer.from(clientBuffer.subarray(message.length));
    logger.debug(`> Remaining buffer`);
    logger.debug(`> Length: ${clientBuffer.length}`);
    logger.debug(`> Raw:`, clientBuffer);
    logger.debug(`> Text: ${clientBuffer.toString() || '<empty>'}`);
    logger.debug(``);
  }
  return clientBuffer;
}

/**
 * 用一个已就绪的 PGlite 实例创建 wire-protocol TCP 服务。
 * @param {import('@electric-sql/pglite').PGlite} db
 * @param {{ logLevel?: number } & net.ServerOpts} [options]
 * @returns {net.Server}
 */
function createServer(db, options = {}) {
  const { logLevel = LogLevel.Info, ...serverOptions } = options;
  const server = net.createServer(serverOptions);

  server.on('connection', function (socket) {
    let clientBuffer = Buffer.allocUnsafe(0);
    const clientAddr = `${socket.remoteAddress}:${socket.remotePort}`;
    const logger = new Logger(logLevel, clientAddr);

    logger.info(`Client connected`);

    socket.on('data', (data) => {
      clientBuffer = Buffer.concat([clientBuffer, data]);
      socket.pause();
      processBuffer(clientBuffer, socket, db, logger)
        .then((remaining) => {
          clientBuffer = remaining;
          socket.resume();
        })
        .catch((err) => {
          logger.error('Unhandled error processing buffer:', err);
          socket.end();
        });
    });

    socket.on('end', () => {
      logger.info(`Client disconnected`);
    });

    socket.on('error', (err) => {
      logger.error(`Client error:`, err);
      socket.end();
    });
  });

  return server;
}

module.exports = { createServer, LogLevel };
