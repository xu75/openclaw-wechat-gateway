import crypto from 'node:crypto';

export interface AgentSignatureInput {
  secret: string;
  method: string;
  path: string;
  timestamp: string;
  body: string;
}

export interface AgentSignatureOutput {
  bodySha256: string;
  signingText: string;
  signature: string;
}

export function sha256Hex(body: string): string {
  return crypto.createHash('sha256').update(body, 'utf8').digest('hex');
}

export function hmacSha256Hex(secret: string, text: string): string {
  return crypto.createHmac('sha256', secret).update(text, 'utf8').digest('hex');
}

export function buildSigningText(method: string, path: string, timestamp: string, bodySha256: string): string {
  return `${method.toUpperCase()}\n${path}\n${timestamp}\n${bodySha256}`;
}

export function signAgentRequest(input: AgentSignatureInput): AgentSignatureOutput {
  const bodySha256 = sha256Hex(input.body);
  const signingText = buildSigningText(input.method, input.path, input.timestamp, bodySha256);
  const signature = hmacSha256Hex(input.secret, signingText);

  return {
    bodySha256,
    signingText,
    signature
  };
}
