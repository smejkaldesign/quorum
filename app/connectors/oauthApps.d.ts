export type OAuthApp = { name: string; client: 'google' | 'notion' | 'slack' | 'github'; exchange: 'direct' | 'relay'; pkce: boolean; authorize: string; scopes: string[]; scopeParam: string | null; scopeSep: string; params: Record<string, string>; scopeNote: string };
export const OAUTH_APPS: Record<string, OAuthApp>;
export const CLIENT_ID_ENV: Record<string, string>;
export const OAUTH_APP_IDS: string[];
export function isOAuthApp(id: string): boolean;
