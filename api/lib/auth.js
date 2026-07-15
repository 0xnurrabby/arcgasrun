const { ethers } = require("ethers");
const { ADMIN, normAddr } = (() => {
  const chain = require("./chain");
  const db = require("./db");
  return { ADMIN: chain.ADMIN, normAddr: db.normAddr };
})();

function isAdminAddress(address) {
  return normAddr(address) === normAddr(ADMIN);
}

/**
 * Verify a personal_sign style signature over a plain message.
 * Message format examples:
 *   gasrun:admin:{timestamp}
 *   gasrun:convert:{address}:{points}:{ts}
 *   gasrun:withdraw:{address}:{usdc}:{ts}
 */
function verifyMessage(address, message, signature) {
  try {
    const recovered = ethers.verifyMessage(message, signature);
    return normAddr(recovered) === normAddr(address);
  } catch {
    return false;
  }
}

function parseJsonBody(req) {
  if (!req.body) return {};
  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }
  return req.body;
}

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function ok(res, data) {
  cors(res);
  res.setHeader("content-type", "application/json");
  res.setHeader("cache-control", "no-store");
  return res.status(200).send(JSON.stringify({ ok: true, ...data }));
}

function fail(res, status, error, extra = {}) {
  cors(res);
  res.setHeader("content-type", "application/json");
  res.setHeader("cache-control", "no-store");
  return res.status(status).send(JSON.stringify({ ok: false, error, ...extra }));
}

module.exports = {
  isAdminAddress,
  verifyMessage,
  parseJsonBody,
  cors,
  ok,
  fail,
  ADMIN,
};
