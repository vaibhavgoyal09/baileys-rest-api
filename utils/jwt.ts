import jwt, { Secret, SignOptions } from 'jsonwebtoken';

const JWT_SECRET: Secret = process.env.JWT_SECRET || process.env.ACCESS_TOKEN_SECRET || 'change-me';
const JWT_EXPIRES_IN: string = process.env.JWT_EXPIRES_IN || '7d';

export type JwtPayload = {
  userId: string;
};

export function signJwt(payload: JwtPayload): string {
  // Avoid TS friction with exactOptionalPropertyTypes by assigning via any
  const opts: SignOptions = {} as any;
  (opts as any).expiresIn = JWT_EXPIRES_IN;
  return jwt.sign(payload as any, JWT_SECRET, opts);
}

export function verifyJwt(token: string): JwtPayload {
  const decoded = jwt.verify(token, JWT_SECRET) as JwtPayload;
  if (!decoded || typeof (decoded as any).userId !== 'string' || !(decoded as any).userId) {
    throw new Error('Invalid token payload');
  }
  return decoded;
}