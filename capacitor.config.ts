import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.wildhaven.zoo',
  appName: 'Wildhaven Zoo',
  webDir: 'dist',
  android: {
    backgroundColor: '#0b1a10',
    allowMixedContent: false,
  },
  plugins: {
    // Google sign-in only: the other providers stay off so their SDKs (and the Facebook / AD_ID
    // manifest entries) are not pulled into the APK.
    SocialLogin: {
      providers: { google: true, facebook: false, apple: false, twitter: false },
      logLevel: 1,
    },
  },
};

export default config;
