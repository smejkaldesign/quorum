export type OAuthApp = { name: string; client: 'google' | 'notion' | 'slack' | 'github'; exchange: 'direct' | 'relay'; pkce: boolean; delegate?: 'gcal'; authorize: string; scopes: string[]; scopeParam: string | null; scopeSep: string; params: Record<string, string>; scopeNote: string };
export const OAUTH_APPS: Record<string, OAuthApp>;
export const CLIENT_ID_ENV: Record<string, string>;
export const GITHUB_APP_SLUG_ENV: string;
export function isOAuthApp(id: string): boolean;
