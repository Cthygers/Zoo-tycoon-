import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.wildhaven.zoo',
  appName: 'Wildhaven Zoo',
  webDir: 'dist',
  android: {
    backgroundColor: '#0b1a10',
    allowMixedContent: false,
  },
};

export default config;
