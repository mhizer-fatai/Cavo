const tls = require("tls");

const GMAIL_HOST = "smtp.gmail.com";
const GMAIL_PORT = 465;
const DEFAULT_GMAIL_USER = "cavopay.auth@gmail.com";
const DEFAULT_EMAIL_FROM = "Cavo <cavopay.auth@gmail.com>";

function getEmailConfig() {
  const user = process.env.GMAIL_USER || DEFAULT_GMAIL_USER;
  const appPassword = process.env.GMAIL_APP_PASSWORD;
  if (!appPassword) {
    throw Object.assign(new Error("GMAIL_APP_PASSWORD is not configured"), { status: 500 });
  }
  return {
    user,
    appPassword,
    from: process.env.EMAIL_FROM || DEFAULT_EMAIL_FROM,
  };
}

function readResponse(socket) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("SMTP response timed out"));
    }, 15000);

    function cleanup() {
      clearTimeout(timeout);
      socket.off("data", onData);
      socket.off("error", onError);
    }

    function onError(error) {
      cleanup();
      reject(error);
    }

    function onData(chunk) {
      buffer += chunk.toString("utf8");
      const lines = buffer.split(/\r?\n/).filter(Boolean);
      const lastLine = lines[lines.length - 1] || "";
      if (/^\d{3}\s/.test(lastLine)) {
        cleanup();
        resolve(buffer);
      }
    }

    socket.on("data", onData);
    socket.on("error", onError);
  });
}

async function sendCommand(socket, command, expectedCodes) {
  socket.write(`${command}\r\n`);
  const response = await readResponse(socket);
  const code = response.slice(0, 3);
  if (!expectedCodes.includes(code)) {
    throw new Error(`SMTP command failed (${command}): ${response.trim()}`);
  }
  return response;
}

function sanitizeHeader(value) {
  return String(value || "").replace(/[\r\n]/g, " ").trim();
}

function dotStuff(body) {
  return body.replace(/\r?\n/g, "\r\n").replace(/^\./gm, "..");
}

function buildMessage({ from, to, subject, html, text }) {
  const boundary = `cavopay_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  return [
    `From: ${sanitizeHeader(from)}`,
    `To: ${sanitizeHeader(to)}`,
    `Subject: ${sanitizeHeader(subject)}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 7bit",
    "",
    text,
    "",
    `--${boundary}`,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: 7bit",
    "",
    html,
    "",
    `--${boundary}--`,
  ].join("\r\n");
}

async function sendEmail({ to, subject, html, text }) {
  const config = getEmailConfig();
  const socket = tls.connect({
    host: GMAIL_HOST,
    port: GMAIL_PORT,
    servername: GMAIL_HOST,
  });

  try {
    await readResponse(socket);
    await sendCommand(socket, "EHLO cavo.local", ["250"]);
    await sendCommand(socket, "AUTH LOGIN", ["334"]);
    await sendCommand(socket, Buffer.from(config.user).toString("base64"), ["334"]);
    await sendCommand(socket, Buffer.from(config.appPassword).toString("base64"), ["235"]);
    await sendCommand(socket, `MAIL FROM:<${config.user}>`, ["250"]);
    await sendCommand(socket, `RCPT TO:<${sanitizeHeader(to)}>`, ["250", "251"]);
    await sendCommand(socket, "DATA", ["354"]);

    const message = buildMessage({
      from: config.from,
      to,
      subject,
      html,
      text,
    });
    socket.write(`${dotStuff(message)}\r\n.\r\n`);
    const dataResponse = await readResponse(socket);
    if (!dataResponse.startsWith("250")) {
      throw new Error(`SMTP DATA failed: ${dataResponse.trim()}`);
    }
    await sendCommand(socket, "QUIT", ["221"]);
  } finally {
    socket.end();
  }
}

module.exports = {
  sendEmail,
};
