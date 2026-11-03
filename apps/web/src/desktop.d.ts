interface FathomStorageInfo {
  cacheDir: string;
  configuredCacheDir: string;
  configuredDataDir: string;
  dataDir: string;
  migrationPending: boolean;
}

interface FathomStorageChooseResult {
  canceled?: boolean;
  changed?: boolean;
  error?: string;
  restartRequired?: boolean;
}

interface Window {
  fathom?: {
    electron: string;
    platform: string;
    storage?: {
      chooseCacheDirectory: () => Promise<FathomStorageChooseResult>;
      chooseDataDirectory: () => Promise<FathomStorageChooseResult>;
      getInfo: () => Promise<FathomStorageInfo>;
      openCacheDirectory: () => Promise<void>;
      openDataDirectory: () => Promise<void>;
      restart: () => Promise<void>;
    };
    workspace?: {
      chooseDirectory: () => Promise<string | null>;
      reveal: (path: string) => Promise<void>;
    };
  };
}
