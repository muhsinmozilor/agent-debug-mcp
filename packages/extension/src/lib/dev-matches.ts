/**
 * Origins where the tools activate automatically (manifest host_permissions and content-script
 * matches). Single source shared by wxt.config.ts and the runtime URL checks; other origins are
 * granted by the user at runtime via optional_host_permissions.
 */
export const DEV_MATCHES = [
  'http://localhost/*',
  'https://localhost/*',
  'http://127.0.0.1/*',
  'https://127.0.0.1/*',
  'http://*.local/*',
  'https://*.local/*',
];
