/**
 * OAuthConnector — generic OAuth 2.0 "authorization code + PKCE" flow used to
 * connect the catalog's `oauth` connectors (Gmail, Microsoft 365, Dropbox,
 * Notion, Slack, …). Zero dependencies: Node's global fetch + crypto.
 *
 * Security model:
 *   - PKCE (S256) so no client_secret is required for public clients — the
 *     same flow works on a desktop loopback or a cloud https origin.
 *   - A random `state` is bound to the pending flow and checked on the
 *     callback to defeat CSRF/login-forcing.
 *   - Pending flows are held in memory with a short TTL; tokens themselves
 *     are persisted in the CredentialVault by UmbraOS (not here).
 *
 * Provider resolution:
 *   1. A well-known provider table (Google, Microsoft, Dropbox, …) with
 *      stable endpoints + default scopes.
 *   2. A per-connector scope map (credentialKey → provider + scopes) so
 *      Gmail, Calendar, Drive, … request the right scopes.
 *   3. Everything else falls back to operator-supplied endpoints in
 *      `config.mcp.oauthClients[<credentialKey>]` — so any provider in the
 *      catalog can be connected once its client is registered.
 */

import * as crypto from 'crypto';
import { getLogger } from '../Logger';

export interface OAuthTokenSet {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  tokenType?: string;
  scope?: string;
}

export interface OAuthClient {
  clientId: string;
  clientSecret?: string;
  authorizeUrl?: string;
  tokenUrl?: string;
  scopes?: string[];
}

export interface BeginOAuthResult {
  authorizeUrl: string;
  state: string;
}

export interface OAuthProviderDef {
  name: string;
  authorizeUrl: string;
  tokenUrl: string;
  scopes: string[];
  /** Static query params added to the authorize URL (e.g. Google's offline access). */
  extraAuthParams?: Record<string, string>;
  /** Providers whose token endpoint also needs the client_secret (GitHub, Slack…). */
  includeSecret?: boolean;
}

const PENDING_TTL_MS = 10 * 60 * 1000;

interface PendingAuth {
  key: string;
  state: string;
  verifier: string;
  redirectUri: string;
  client: OAuthClient;
  provider: OAuthProviderDef;
  createdAt: number;
}

/** Well-known providers with stable, publicly-documented endpoints. */
export const OAUTH_PROVIDERS: Record<string, OAuthProviderDef> = {
  google: {
    name: 'Google',
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes: ['openid', 'email', 'profile'],
    extraAuthParams: { access_type: 'offline', prompt: 'consent' },
  },
  microsoft: {
    name: 'Microsoft',
    authorizeUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    scopes: ['offline_access', 'User.Read'],
  },
  dropbox: {
    name: 'Dropbox',
    authorizeUrl: 'https://www.dropbox.com/oauth2/authorize',
    tokenUrl: 'https://api.dropboxapi.com/oauth2/token',
    scopes: [],
  },
  github: {
    name: 'GitHub',
    authorizeUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    scopes: ['repo', 'read:user'],
    includeSecret: true,
  },
  linear: {
    name: 'Linear',
    authorizeUrl: 'https://linear.app/oauth/authorize',
    tokenUrl: 'https://api.linear.app/oauth/token',
    scopes: ['read', 'write'],
  },
  notion: {
    name: 'Notion',
    authorizeUrl: 'https://api.notion.com/v1/oauth/authorize',
    tokenUrl: 'https://api.notion.com/v1/oauth/token',
    scopes: [],
  },
  slack: {
    name: 'Slack',
    authorizeUrl: 'https://slack.com/oauth/v2/authorize',
    tokenUrl: 'https://slack.com/api/oauth.v2.access',
    scopes: ['channels:read', 'chat:write'],
    includeSecret: true,
  },
  spotify: {
    name: 'Spotify',
    authorizeUrl: 'https://accounts.spotify.com/authorize',
    tokenUrl: 'https://accounts.spotify.com/api/token',
    scopes: ['user-read-playback-state', 'playlist-read-private'],
  },
  figma: {
    name: 'Figma',
    authorizeUrl: 'https://www.figma.com/oauth',
    tokenUrl: 'https://www.figma.com/api/oauth/token',
    scopes: ['files:read'],
  },
  box: {
    name: 'Box',
    authorizeUrl: 'https://account.box.com/api/oauth2/authorize',
    tokenUrl: 'https://api.box.com/oauth2/token',
    scopes: [],
  },
  reddit: {
    name: 'Reddit',
    authorizeUrl: 'https://www.reddit.com/api/v1/authorize',
    tokenUrl: 'https://www.reddit.com/api/v1/access_token',
    scopes: ['read', 'identity'],
  },
  evernote: {
    name: 'Evernote',
    authorizeUrl: 'https://www.evernote.com/oauth',
    tokenUrl: 'https://www.evernote.com/oauth',
    scopes: ['basic'],
  },
  twitch: {
    name: 'Twitch',
    authorizeUrl: 'https://id.twitch.tv/oauth2/authorize',
    tokenUrl: 'https://id.twitch.tv/oauth2/token',
    scopes: ['user:read:email'],
  },
  paypal: {
    name: 'PayPal',
    authorizeUrl: 'https://www.paypal.com/signin/authorize',
    tokenUrl: 'https://api.paypal.com/v1/oauth2/token',
    scopes: ['openid', 'email', 'profile'],
  },
  xero: {
    name: 'Xero',
    authorizeUrl: 'https://login.xero.com/identity/connect/authorize',
    tokenUrl: 'https://identity.xero.com/connect/token',
    scopes: ['openid', 'profile', 'email', 'offline_access'],
  },
  quickbooks: {
    name: 'QuickBooks',
    authorizeUrl: 'https://appcenter.intuit.com/connect/oauth2',
    tokenUrl: 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer',
    scopes: ['com.intuit.quickbooks.accounting', 'openid', 'profile', 'email'],
  },
  amazon: {
    name: 'Amazon',
    authorizeUrl: 'https://www.amazon.com/ap/oa',
    tokenUrl: 'https://api.amazon.com/auth/o2/token',
    scopes: ['profile'],
  },
  ebay: {
    name: 'eBay',
    authorizeUrl: 'https://www.ebay.com/oauth2/authorize',
    tokenUrl: 'https://api.ebay.com/identity/v1/oauth2/token',
    scopes: ['https://api.ebay.com/oauth/api_scope'],
  },
  twitter: {
    name: 'Twitter / X',
    authorizeUrl: 'https://twitter.com/i/oauth2/authorize',
    tokenUrl: 'https://api.twitter.com/2/oauth2/token',
    scopes: ['tweet.read', 'users.read', 'offline.access'],
    includeSecret: true,
  },
  facebook: {
    name: 'Facebook',
    authorizeUrl: 'https://www.facebook.com/v21.0/dialog/oauth',
    tokenUrl: 'https://graph.facebook.com/v21.0/oauth/access_token',
    scopes: [],
  },
  instagram: {
    name: 'Instagram',
    authorizeUrl: 'https://api.instagram.com/oauth/authorize',
    tokenUrl: 'https://api.instagram.com/oauth/access_token',
    scopes: ['user_profile', 'user_media'],
  },
  tiktok: {
    name: 'TikTok',
    authorizeUrl: 'https://www.tiktok.com/v2/auth/authorize/',
    tokenUrl: 'https://open.tiktokapis.com/v2/oauth/token/',
    scopes: [],
  },
  pinterest: {
    name: 'Pinterest',
    authorizeUrl: 'https://www.pinterest.com/oauth/',
    tokenUrl: 'https://api.pinterest.com/v5/oauth/token',
    scopes: [],
  },
  tumblr: {
    name: 'Tumblr',
    authorizeUrl: 'https://www.tumblr.com/oauth2/authorize',
    tokenUrl: 'https://api.tumblr.com/v2/oauth2/token',
    scopes: ['basic'],
    includeSecret: true,
  },
  snapchat: {
    name: 'Snapchat',
    authorizeUrl: 'https://accounts.snapchat.com/accounts/oauth2/auth',
    tokenUrl: 'https://accounts.snapchat.com/accounts/oauth2/token',
    scopes: ['https://auth.snapchat.com/oauth2/api/user.read'],
    includeSecret: true,
  },
  linkedin: {
    name: 'LinkedIn',
    authorizeUrl: 'https://www.linkedin.com/oauth/v2/authorization',
    tokenUrl: 'https://www.linkedin.com/oauth/v2/accessToken',
    scopes: ['openid', 'profile', 'email'],
    includeSecret: true,
  },
  adobe: {
    name: 'Adobe',
    authorizeUrl: 'https://ims-na1.adobelogin.com/ims/authorize/v2',
    tokenUrl: 'https://ims-na1.adobelogin.com/ims/token/v3',
    scopes: ['openid', 'AdobeID', 'read_organizations'],
  },
  fitbit: {
    name: 'Fitbit',
    authorizeUrl: 'https://www.fitbit.com/oauth2/authorize',
    tokenUrl: 'https://api.fitbit.com/oauth2/token',
    scopes: [],
    includeSecret: true,
  },
  withings: {
    name: 'Withings',
    authorizeUrl: 'https://account.withings.com/oauth2_user/authorize',
    tokenUrl: 'https://account.withings.com/oauth2_access_token',
    scopes: [],
  },
  garmin: {
    name: 'Garmin',
    authorizeUrl: 'https://connect.garmin.com/oauth2Confirm',
    tokenUrl: 'https://connectapi.garmin.com/oauth-service/oauth/request',
    scopes: [],
    includeSecret: true,
  },
  freshbooks: {
    name: 'FreshBooks',
    authorizeUrl: 'https://auth.freshbooks.com/oauth/authorize/',
    tokenUrl: 'https://api.freshbooks.com/auth/oauth/token',
    scopes: [],
  },
  wave: {
    name: 'Wave',
    authorizeUrl: 'https://api.waveapps.com/oauth2/authorize/',
    tokenUrl: 'https://api.waveapps.com/oauth2/token/',
    scopes: [],
    includeSecret: true,
  },
  revolut: {
    name: 'Revolut',
    authorizeUrl: 'https://www.revolut.com/auth/authorize',
    tokenUrl: 'https://api.revolut.com/api/1.0/auth/token',
    scopes: [],
  },
  monzo: {
    name: 'Monzo',
    authorizeUrl: 'https://auth.monzo.com/',
    tokenUrl: 'https://api.monzo.com/oauth2/token',
    scopes: [],
  },
  truelayer: {
    name: 'TrueLayer',
    authorizeUrl: 'https://truelayer-sandbox.com/oauth/authorize',
    tokenUrl: 'https://api.truelayer-sandbox.com/oauth/token',
    scopes: [],
    includeSecret: true,
  },
  alibaba: {
    name: 'Alibaba',
    authorizeUrl: 'https://open.1688.com/open/oauth2/authorize',
    tokenUrl: 'https://api.1688.com/openapi/1.0/token',
    scopes: [],
  },
  wix: {
    name: 'Wix',
    authorizeUrl: 'https://www.wix.com/_serverless/oauth2/authorize',
    tokenUrl: 'https://www.wix.com/_serverless/oauth2/token',
    scopes: [],
  },
  woocommerce: {
    name: 'WooCommerce',
    authorizeUrl: 'https://connect.woocommerce.com/auth/authorize/',
    tokenUrl: 'https://connect.woocommerce.com/auth/token/',
    scopes: ['read'],
  },
  hubspot: {
    name: 'HubSpot',
    authorizeUrl: 'https://app.hubspot.com/oauth/authorize',
    tokenUrl: 'https://api.hubapi.com/oauth/v1/token',
    scopes: ['oauth'],
  },
  asana: {
    name: 'Asana',
    authorizeUrl: 'https://app.asana.com/-/oauth_authorize',
    tokenUrl: 'https://app.asana.com/-/oauth_token',
    scopes: [],
    includeSecret: true,
  },
  atlassian: {
    name: 'Atlassian',
    authorizeUrl: 'https://auth.atlassian.com/authorize',
    tokenUrl: 'https://auth.atlassian.com/oauth/token',
    scopes: ['read:jira-work', 'offline_access'],
  },
  zoom: {
    name: 'Zoom',
    authorizeUrl: 'https://zoom.us/oauth/authorize',
    tokenUrl: 'https://zoom.us/oauth/token',
    scopes: ['user:read'],
  },
  salesforce: {
    name: 'Salesforce',
    authorizeUrl: 'https://login.salesforce.com/services/oauth2/authorize',
    tokenUrl: 'https://login.salesforce.com/services/oauth2/token',
    scopes: ['openid', 'api', 'refresh_token'],
  },
  soundcloud: {
    name: 'SoundCloud',
    authorizeUrl: 'https://secure.soundcloud.com/authorize',
    tokenUrl: 'https://secure.soundcloud.com/oauth/token',
    scopes: [],
    includeSecret: true,
  },
  tidal: {
    name: 'TIDAL',
    authorizeUrl: 'https://login.tidal.com/authorize',
    tokenUrl: 'https://auth.tidal.com/v1/oauth2/token',
    scopes: [],
    includeSecret: true,
  },
  podbean: {
    name: 'Podbean',
    authorizeUrl: 'https://api.podbean.com/v1/oauth/authorize',
    tokenUrl: 'https://api.podbean.com/v1/oauth/token',
    scopes: [],
  },
  trakt: {
    name: 'Trakt',
    authorizeUrl: 'https://trakt.tv/oauth/authorize',
    tokenUrl: 'https://api.trakt.tv/oauth/token',
    scopes: [],
    includeSecret: true,
  },
  unsplash: {
    name: 'Unsplash',
    authorizeUrl: 'https://unsplash.com/oauth/authorize',
    tokenUrl: 'https://unsplash.com/oauth/token',
    scopes: [],
    includeSecret: true,
  },
  shutterstock: {
    name: 'Shutterstock',
    authorizeUrl: 'https://www.shutterstock.com/oauth/authorize',
    tokenUrl: 'https://api.shutterstock.com/oauth/access_token',
    scopes: [],
  },
  canva: {
    name: 'Canva',
    authorizeUrl: 'https://www.canva.com/api/oauth/authorize',
    tokenUrl: 'https://api.canva.com/rest/v1/oauth/token',
    scopes: ['design:content:read'],
  },
  framer: {
    name: 'Framer',
    authorizeUrl: 'https://www.framer.com/mcp/oauth/authorize',
    tokenUrl: 'https://api.framer.com/auth/oauth/token',
    scopes: [],
  },
  feedly: {
    name: 'Feedly',
    authorizeUrl: 'https://cloud.feedly.com/v3/auth/authorize',
    tokenUrl: 'https://cloud.feedly.com/v3/auth/token',
    scopes: [],
  },
  inoreader: {
    name: 'Inoreader',
    authorizeUrl: 'https://www.inoreader.com/oauth2/authorize',
    tokenUrl: 'https://www.inoreader.com/oauth2/token',
    scopes: [],
  },
  pocket: {
    name: 'Pocket',
    authorizeUrl: 'https://getpocket.com/v3/oauth/authorize',
    tokenUrl: 'https://getpocket.com/v3/oauth/authorize',
    scopes: [],
  },
  mendeley: {
    name: 'Mendeley',
    authorizeUrl: 'https://api.mendeley.com/oauth/authorize',
    tokenUrl: 'https://api.mendeley.com/oauth/token',
    scopes: ['all'],
    includeSecret: true,
  },
  overleaf: {
    name: 'Overleaf',
    authorizeUrl: 'https://www.overleaf.com/oauth/authorize',
    tokenUrl: 'https://www.overleaf.com/oauth/token',
    scopes: [],
  },
  grab: {
    name: 'Grab',
    authorizeUrl: 'https://api.staging.grab.com/v1/oauth/authorize',
    tokenUrl: 'https://api.staging.grab.com/v1/oauth/token',
    scopes: [],
  },
  ecobee: {
    name: 'ecobee',
    authorizeUrl: 'https://www.ecobee.com/authorize',
    tokenUrl: 'https://api.ecobee.com/oauth/token',
    scopes: [],
  },
  honeywell: {
    name: 'Honeywell',
    authorizeUrl: 'https://nxaixcloud.b2clogin.com/oidc/authorize',
    tokenUrl: 'https://nxaixcloud.b2clogin.com/oidc/token',
    scopes: [],
  },
  netatmo: {
    name: 'Netatmo',
    authorizeUrl: 'https://dev.netatmo.com/authorize',
    tokenUrl: 'https://dev.netatmo.com/token',
    scopes: [],
  },
  foursquare: {
    name: 'Foursquare',
    authorizeUrl: 'https://foursquare.com/oauth2/authenticate',
    tokenUrl: 'https://foursquare.com/oauth2/access_token',
    scopes: [],
  },
  'sentinel-hub': {
    name: 'Sentinel Hub',
    authorizeUrl: 'https://services.sentinel-hub.com/oauth/auth/realms/sentinel-hub/protocol/openid-connect/auth',
    tokenUrl: 'https://services.sentinel-hub.com/oauth/auth/realms/sentinel-hub/protocol/openid-connect/token',
    scopes: [],
  },
  upwork: {
    name: 'Upwork',
    authorizeUrl: 'https://www.upwork.com/services/api/auth',
    tokenUrl: 'https://www.upwork.com/api/auth/v1/token',
    scopes: [],
  },
  freelancer: {
    name: 'Freelancer',
    authorizeUrl: 'https://www.freelancer.com/api/oauth/authorize',
    tokenUrl: 'https://www.freelancer.com/api/oauth/token',
    scopes: [],
  },
  chargepoint: {
    name: 'ChargePoint',
    authorizeUrl: 'https://www.chargepoint.com/oauth2/authorize',
    tokenUrl: 'https://www.chargepoint.com/oauth2/token',
    scopes: [],
  },
  amadeus: {
    name: 'Amadeus',
    authorizeUrl: 'https://developers.amadeus.com/oauth2/authorize',
    tokenUrl: 'https://developers.amadeus.com/oauth2/token',
    scopes: [],
    includeSecret: true,
  },
  gusto: {
    name: 'Gusto',
    authorizeUrl: 'https://partner.gusto.com/oauth/authorize',
    tokenUrl: 'https://partner.gusto.com/oauth/token',
    scopes: [],
    includeSecret: true,
  },
  adp: {
    name: 'ADP',
    authorizeUrl: 'https://api.adp.com/oauth2/v2/authorize',
    tokenUrl: 'https://api.adp.com/oauth2/v2/token',
    scopes: ['openid'],
  },
  sap: {
    name: 'SAP',
    authorizeUrl: 'https://account.sap.com/oauth/authorize',
    tokenUrl: 'https://api.sap.com/oauth/token',
    scopes: [],
  },
  oracle: {
    name: 'Oracle',
    authorizeUrl: 'https://login.oracle.com/oauth/v1/authorize',
    tokenUrl: 'https://login.oracle.com/oauth/v1/token',
    scopes: ['openid', 'profile', 'email'],
  },
  netsuite: {
    name: 'NetSuite',
    authorizeUrl: 'https://system.na1.netsuite.com/oauth2/v1/authorize',
    tokenUrl: 'https://system.na1.netsuite.com/oauth2/v1/token',
    scopes: [],
  },
  podio: {
    name: 'Podio',
    authorizeUrl: 'https://podio.com/oauth/authorize',
    tokenUrl: 'https://podio.com/oauth/token',
    scopes: [],
    includeSecret: true,
  },
  weibo: {
    name: 'Weibo',
    authorizeUrl: 'https://api.weibo.com/oauth2/authorize',
    tokenUrl: 'https://api.weibo.com/oauth2/access_token',
    scopes: [],
  },
  naver: {
    name: 'Naver',
    authorizeUrl: 'https://nid.naver.com/oauth2.0/authorize',
    tokenUrl: 'https://nid.naver.com/oauth2.0/token',
    scopes: [],
  },
  dribbble: {
    name: 'Dribbble',
    authorizeUrl: 'https://dribbble.com/oauth/authorize',
    tokenUrl: 'https://dribbble.com/oauth/token',
    scopes: [],
    includeSecret: true,
  },
  'noun-project': {
    name: 'Noun Project',
    authorizeUrl: 'https://api.nounproject.com/oauth/authorize',
    tokenUrl: 'https://api.nounproject.com/oauth/token',
    scopes: [],
  },
  '500px': {
    name: '500px',
    authorizeUrl: 'https://api.500px.com/v1/oauth/authorize',
    tokenUrl: 'https://api.500px.com/v1/oauth/token',
    scopes: [],
  },
  betfair: {
    name: 'Betfair',
    authorizeUrl: 'https://identity.betfair.com/oauth2/auth',
    tokenUrl: 'https://identity.betfair.com/oauth2/token',
    scopes: [],
    includeSecret: true,
  },
  affirm: {
    name: 'Affirm',
    authorizeUrl: 'https://identity.affirm.com/api/oauth/authorize',
    tokenUrl: 'https://identity.affirm.com/api/oauth/token',
    scopes: [],
  },
  afterpay: {
    name: 'Afterpay',
    authorizeUrl: 'https://api.afterpay.com/oauth2/authorize',
    tokenUrl: 'https://api.afterpay.com/oauth2/token',
    scopes: [],
  },
  sezzle: {
    name: 'Sezzle',
    authorizeUrl: 'https://auth.sezzle.com/oauth/authorize',
    tokenUrl: 'https://auth.sezzle.com/oauth/token',
    scopes: [],
    includeSecret: true,
  },
  mercadolibre: {
    name: 'Mercado Libre',
    authorizeUrl: 'https://auth.mercadolibre.com.ar/authorization',
    tokenUrl: 'https://api.mercadolibre.com/oauth/token',
    scopes: ['offline_access'],
  },
  workday: {
    name: 'Workday',
    authorizeUrl: 'https://wd2-impl-services1.workday.com/ccx/oauth2/authorize',
    tokenUrl: 'https://wd2-impl-services1.workday.com/ccx/oauth2/token',
    scopes: [],
  },
  mercedes: {
    name: 'Mercedes-Benz',
    authorizeUrl: 'https://api.mercedes-benz.com/oauth2/authorize',
    tokenUrl: 'https://api.mercedes-benz.com/oauth2/token',
    scopes: [],
  },
  ford: {
    name: 'Ford',
    authorizeUrl: 'https://developer.ford.com/accounts/login/oauth2/v2/authorize',
    tokenUrl: 'https://developer.ford.com/accounts/login/oauth2/v2/token',
    scopes: [],
    includeSecret: true,
  },
  shopify: {
    name: 'Shopify',
    authorizeUrl: 'https://{shop}.myshopify.com/admin/oauth/authorize',
    tokenUrl: 'https://{shop}.myshopify.com/admin/oauth/access_token',
    scopes: ['read_products'],
  },
  sipgate: {
    name: 'sipgate',
    authorizeUrl: 'https://sipgate.com/oauth/authorize',
    tokenUrl: 'https://sipgate.com/oauth/token',
    scopes: [],
  },
  ringcentral: {
    name: 'RingCentral',
    authorizeUrl: 'https://platform.ringcentral.com/oauth/authorize',
    tokenUrl: 'https://platform.ringcentral.com/oauth/token',
    scopes: ['ReadAccounts'],
  },
};

/**
 * credentialKey → { provider, scopes }. Only the connectors whose scopes
 * differ from the provider default (or where the credentialKey ≠ provider
 * slug) need an entry; everything else resolves via `providerFor`.
 */
const CONNECTOR_OAUTH: Record<string, { provider: string; scopes: string[] }> = {
  // Google workspace (scoped per product)
  gmail: { provider: 'google', scopes: ['https://www.googleapis.com/auth/gmail.modify'] },
  'google-calendar': { provider: 'google', scopes: ['https://www.googleapis.com/auth/calendar'] },
  'google-drive': { provider: 'google', scopes: ['https://www.googleapis.com/auth/drive'] },
  'google-docs': { provider: 'google', scopes: ['https://www.googleapis.com/auth/documents'] },
  'google-sheets': { provider: 'google', scopes: ['https://www.googleapis.com/auth/spreadsheets'] },
  bigquery: { provider: 'google', scopes: ['https://www.googleapis.com/auth/bigquery'] },
  gcp: { provider: 'google', scopes: ['https://www.googleapis.com/auth/cloud-platform'] },
  ga4: { provider: 'google', scopes: ['https://www.googleapis.com/auth/analytics.readonly'] },
  'search-console': { provider: 'google', scopes: ['https://www.googleapis.com/auth/webmasters.readonly'] },
  'google-fit': { provider: 'google', scopes: ['https://www.googleapis.com/auth/fitness.activity.read'] },
  blogger: { provider: 'google', scopes: ['https://www.googleapis.com/auth/blogger'] },
  'google-identity': { provider: 'google', scopes: ['openid', 'email', 'profile'] },
  // Microsoft / Azure AD
  'microsoft-365': { provider: 'microsoft', scopes: ['offline_access', 'User.Read', 'Mail.Read', 'Calendars.ReadWrite', 'Files.ReadWrite'] },
  onedrive: { provider: 'microsoft', scopes: ['offline_access', 'Files.ReadWrite'] },
  teams: { provider: 'microsoft', scopes: ['offline_access', 'User.Read', 'ChannelMessage.ReadWrite', 'Team.ReadBasic.All'] },
  'azure-ad': { provider: 'microsoft', scopes: ['offline_access', 'User.Read', 'Directory.Read.All'] },
  // Named providers whose slug differs from the credentialKey
  'notion-calendar': { provider: 'notion', scopes: [] },
  // Consumer/social + commerce providers
  messenger: { provider: 'facebook', scopes: [] },
  'facebook-messenger': { provider: 'facebook', scopes: [] },
  'instagram-messaging': { provider: 'facebook', scopes: [] },
  instagram: { provider: 'facebook', scopes: [] },
  facebook: { provider: 'facebook', scopes: [] },
  tiktok: { provider: 'tiktok', scopes: [] },
  pinterest: { provider: 'pinterest', scopes: [] },
  tumblr: { provider: 'tumblr', scopes: [] },
  threads: { provider: 'facebook', scopes: [] },
  snapchat: { provider: 'snapchat', scopes: [] },
  linkedin: { provider: 'linkedin', scopes: [] },
  behance: { provider: 'adobe', scopes: [] },
  'adobe-creative-cloud': { provider: 'adobe', scopes: [] },
  // Health / fitness
  fitbit: { provider: 'fitbit', scopes: [] },
  withings: { provider: 'withings', scopes: [] },
  garmin: { provider: 'garmin', scopes: [] },
  // Finance / accounting
  paypal: { provider: 'paypal', scopes: [] },
  xero: { provider: 'xero', scopes: [] },
  quickbooks: { provider: 'quickbooks', scopes: [] },
  freshbooks: { provider: 'freshbooks', scopes: [] },
  wave: { provider: 'wave', scopes: [] },
  revolut: { provider: 'revolut', scopes: [] },
  monzo: { provider: 'monzo', scopes: [] },
  truelayer: { provider: 'truelayer', scopes: [] },
  // Commerce / marketplace
  'amazon-sp-api': { provider: 'amazon', scopes: [] },
  ebay: { provider: 'ebay', scopes: [] },
  alibaba: { provider: 'alibaba', scopes: [] },
  wix: { provider: 'wix', scopes: [] },
  woocommerce: { provider: 'woocommerce', scopes: [] },
  // Productivity / dev
  shopify: { provider: 'shopify', scopes: [] },
  hubspot: { provider: 'hubspot', scopes: [] },
  asana: { provider: 'asana', scopes: [] },
  jira: { provider: 'atlassian', scopes: [] },
  confluence: { provider: 'atlassian', scopes: [] },
  'zoom-phone': { provider: 'zoom', scopes: [] },
  salesforce: { provider: 'salesforce', scopes: [] },
  workday: { provider: 'workday', scopes: [] },
  gusto: { provider: 'gusto', scopes: [] },
  // Media / content
  soundcloud: { provider: 'soundcloud', scopes: [] },
  tidal: { provider: 'tidal', scopes: [] },
  podbean: { provider: 'podbean', scopes: [] },
  trakt: { provider: 'trakt', scopes: [] },
  unsplash: { provider: 'unsplash', scopes: [] },
  shutterstock: { provider: 'shutterstock', scopes: [] },
  canva: { provider: 'canva', scopes: [] },
  framer: { provider: 'framer', scopes: [] },
  // Reading / education / misc
  feedly: { provider: 'feedly', scopes: [] },
  inoreader: { provider: 'inoreader', scopes: [] },
  pocket: { provider: 'pocket', scopes: [] },
  mendeley: { provider: 'mendeley', scopes: [] },
  overleaf: { provider: 'overleaf', scopes: [] },
  grab: { provider: 'grab', scopes: [] },
  // Banking / insurance
  mercedes: { provider: 'mercedes', scopes: [] },
  ford: { provider: 'ford', scopes: [] },
  chargepoint: { provider: 'chargepoint', scopes: [] },
  amadeus: { provider: 'amadeus', scopes: [] },
  // Other
  ecobee: { provider: 'ecobee', scopes: [] },
  honeywell: { provider: 'honeywell', scopes: [] },
  netatmo: { provider: 'netatmo', scopes: [] },
  foursquare: { provider: 'foursquare', scopes: [] },
  'sentinel-hub': { provider: 'sentinel-hub', scopes: [] },
  upwork: { provider: 'upwork', scopes: [] },
  freelancer: { provider: 'freelancer', scopes: [] },
  'linkedin-learning': { provider: 'linkedin', scopes: [] },
  betfair: { provider: 'betfair', scopes: [] },
  afterpay: { provider: 'afterpay', scopes: [] },
  affirm: { provider: 'affirm', scopes: [] },
  sezzle: { provider: 'sezzle', scopes: [] },
  mercadolibre: { provider: 'mercadolibre', scopes: [] },
  adp: { provider: 'adp', scopes: [] },
  sap: { provider: 'sap', scopes: [] },
  oracle: { provider: 'oracle', scopes: [] },
  netsuite: { provider: 'netsuite', scopes: [] },
  podio: { provider: 'podio', scopes: [] },
  weibo: { provider: 'weibo', scopes: [] },
  naver: { provider: 'naver', scopes: [] },
  '500px': { provider: '500px', scopes: [] },
  dribbble: { provider: 'dribbble', scopes: [] },
  'noun-project': { provider: 'noun-project', scopes: [] },
  'google-cloud': { provider: 'google', scopes: ['https://www.googleapis.com/auth/cloud-platform'] },
  'google-analytics': { provider: 'google', scopes: ['https://www.googleapis.com/auth/analytics.readonly'] },
};

/**
 * Catalog ids are `<category>-<name>` (e.g. `productivity-gmail`), while the
 * provider table is keyed by the credentialKey (`gmail`) or the provider slug.
 * Strip a leading category segment so catalog ids resolve too — this is what
 * lets `resolve()` be called with either form.
 */
function stripCategoryPrefix(key: string): string {
  const parts = key.split('-');
  if (parts.length < 2) return key;
  // Try the tail first (longest match wins): `productivity-google-drive` → `google-drive`.
  for (let i = 1; i < parts.length; i++) {
    const candidate = parts.slice(i).join('-');
    if (CONNECTOR_OAUTH[candidate] || OAUTH_PROVIDERS[candidate]) return candidate;
  }
  return key;
}

/** Guess a provider slug from a connector credentialKey or catalog id. */
function providerSlugFor(key: string): string | undefined {
  if (CONNECTOR_OAUTH[key]) return CONNECTOR_OAUTH[key].provider;
  if (OAUTH_PROVIDERS[key]) return key;

  const tail = stripCategoryPrefix(key);
  if (CONNECTOR_OAUTH[tail]) return CONNECTOR_OAUTH[tail].provider;
  if (OAUTH_PROVIDERS[tail]) return tail;

  // Fall back to a provider named after the first segment (e.g. `paypal-*`).
  const head = key.split('-')[0];
  if (OAUTH_PROVIDERS[head]) return head;

  return undefined;
}

export interface ResolvedOAuth {
  client: OAuthClient;
  provider: OAuthProviderDef;
}

/**
 * Is a connector's OAuth provider known to the registry (so only a clientId is
 * needed, not hand-written endpoints)? Used to report honest readiness without
 * constructing a client.
 */
export function hasKnownOAuthProvider(key: string): boolean {
  return providerSlugFor(key) !== undefined;
}

/** The provider slug for a connector key, if the registry knows it. */
export function oauthProviderSlugFor(key: string): string | undefined {
  return providerSlugFor(key);
}

export class OAuthConnector {
  private pending = new Map<string, PendingAuth>();
  private fetchImpl: typeof fetch;

  constructor(fetchImpl?: typeof fetch) {
    this.fetchImpl = fetchImpl ?? ((url, init) => fetch(url, init));
  }

  /**
   * Resolve a connector's OAuth endpoints + scopes from the operator's
   * client config. Known providers use their registry defaults; unknown ones
   * require `authorizeUrl`/`tokenUrl` in the client config.
   */
  resolve(key: string, client: OAuthClient): ResolvedOAuth {
    const slug = providerSlugFor(key);
    const base = slug ? OAUTH_PROVIDERS[slug] : undefined;
    const tail = stripCategoryPrefix(key);

    if (!base && (!client.authorizeUrl || !client.tokenUrl)) {
      throw new Error(
        `No OAuth endpoints configured for "${key}" — add mcp.oauthClients["${key}"] with clientId + authorizeUrl + tokenUrl`,
      );
    }

    // Scopes: an explicit client config wins, then the per-connector map
    // (looked up by both the raw key and its category-stripped tail), then
    // the provider default.
    const mapped = CONNECTOR_OAUTH[key] ?? CONNECTOR_OAUTH[tail];
    const provider: OAuthProviderDef = {
      name: base?.name ?? key,
      authorizeUrl: client.authorizeUrl || base!.authorizeUrl,
      tokenUrl: client.tokenUrl || base!.tokenUrl,
      scopes: client.scopes ?? (mapped?.scopes ?? base?.scopes ?? []),
      extraAuthParams: base?.extraAuthParams,
      includeSecret: base?.includeSecret,
    };

    if (!client.clientId) {
      throw new Error(`OAuth clientId is required for "${key}" (register an app with the provider first)`);
    }

    return { client, provider };
  }

  /** Start the flow: build the authorize URL and remember the PKCE/state. */
  begin(key: string, client: OAuthClient, redirectUri: string): BeginOAuthResult {
    const { provider } = this.resolve(key, client);
    const verifier = this.generateVerifier();
    const state = crypto.randomBytes(16).toString('hex');
    const challenge = this.codeChallenge(verifier);

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: client.clientId,
      redirect_uri: redirectUri,
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    if (provider.scopes.length) params.set('scope', provider.scopes.join(' '));
    for (const [k, v] of Object.entries(provider.extraAuthParams ?? {})) params.set(k, v);

    this.prune();
    this.pending.set(state, {
      key,
      state,
      verifier,
      redirectUri,
      client,
      provider,
      createdAt: Date.now(),
    });

    getLogger().info({ key, provider: provider.name }, 'OAuth flow started');
    return { authorizeUrl: `${provider.authorizeUrl}?${params.toString()}`, state };
  }

  /**
   * Exchange the authorization code for tokens (validates state first).
   * The callback only receives `code` + `state`, so the connector id is
   * recovered from the pending flow and returned alongside the tokens.
   */
  async complete(code: string, state: string): Promise<{ key: string; tokens: OAuthTokenSet }> {
    const pending = this.pending.get(state);
    if (!pending) throw new Error('Unknown or expired OAuth state — start the flow again');
    this.pending.delete(state);

    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: pending.redirectUri,
      client_id: pending.client.clientId,
      code_verifier: pending.verifier,
    });
    if (pending.client.clientSecret && pending.provider.includeSecret) {
      body.set('client_secret', pending.client.clientSecret);
    }

    const tokens = await this.exchange(pending.provider.tokenUrl, body);
    getLogger().info({ key: pending.key }, 'OAuth flow completed');
    return { key: pending.key, tokens };
  }

  /** Refresh an access token (no-op-safe when the provider gave no refresh token). */
  async refresh(client: OAuthClient, provider: OAuthProviderDef, refreshToken: string): Promise<OAuthTokenSet> {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: client.clientId,
    });
    if (client.clientSecret) body.set('client_secret', client.clientSecret);
    return this.exchange(provider.tokenUrl, body);
  }

  // ── PKCE helpers ──────────────────────────────────────────

  generateVerifier(): string {
    // 48 bytes → 64 base64url chars, within RFC 7636's 43–128 range.
    return crypto.randomBytes(48).toString('base64url');
  }

  codeChallenge(verifier: string): string {
    return crypto.createHash('sha256').update(verifier).digest('base64url');
  }

  // ── internals ─────────────────────────────────────────────

  private async exchange(tokenUrl: string, body: URLSearchParams): Promise<OAuthTokenSet> {
    const res = await this.fetchImpl(tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: body.toString(),
    });

    const text = await res.text();
    if (!res.ok) {
      throw new Error(`OAuth token exchange failed (${res.status}): ${text.slice(0, 200)}`);
    }

    const json = this.parseTokenPayload(text);
    if (!json.access_token) {
      throw new Error('OAuth token response did not include an access_token');
    }
    return {
      accessToken: String(json.access_token),
      refreshToken: json.refresh_token ? String(json.refresh_token) : undefined,
      expiresAt: Date.now() + Number(json.expires_in ?? 3600) * 1000,
      tokenType: json.token_type ? String(json.token_type) : undefined,
      scope: json.scope ? String(json.scope) : undefined,
    };
  }

  private parseTokenPayload(text: string): Record<string, unknown> {
    try {
      return JSON.parse(text);
    } catch {
      // Some providers (GitHub) return form-encoded bodies unless asked.
      return Object.fromEntries(new URLSearchParams(text));
    }
  }

  private prune(): void {
    const cutoff = Date.now() - PENDING_TTL_MS;
    for (const [state, p] of this.pending) {
      if (p.createdAt < cutoff) this.pending.delete(state);
    }
  }
}
