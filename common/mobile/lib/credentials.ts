import AsyncStorage from '@react-native-async-storage/async-storage';

export const isReleaseTransport =
  typeof __DEV__ !== 'undefined'
    ? !__DEV__
    : process.env.NODE_ENV === 'production' ||
      process.env.EXPO_PUBLIC_BLINKY_TRANSPORT_MODE === 'release';

type NativeSecureSocketModule = typeof import('../modules/blinky-secure-socket');

function loadNativeSecureSocketModule(): NativeSecureSocketModule | null {
  try {
    return require('../modules/blinky-secure-socket') as NativeSecureSocketModule;
  } catch {
    return null;
  }
}

/**
 * Reads a credential from hardware-backed storage in release builds
 * (Android Keystore / iOS Keychain via the native secure-socket module),
 * AsyncStorage in development (Expo Go compatibility).
 */
export const readSavedCredential = async (
  secureKey: string,
  legacyKey: string,
): Promise<string | null> => {
  if (isReleaseTransport) {
    const mod = loadNativeSecureSocketModule();
    if (mod && 'isNative' in mod && !(mod as any).isNative) return null;
    return mod?.getSecureValue(secureKey) || null;
  }
  return AsyncStorage.getItem(legacyKey);
};

/**
 * Persists a credential. Release builds throw when secure storage is
 * unavailable instead of falling back to plaintext.
 */
export const saveCredential = async (
  secureKey: string,
  legacyKey: string,
  value: string,
): Promise<void> => {
  if (isReleaseTransport) {
    const nativeModule = loadNativeSecureSocketModule();
    if (!nativeModule || ('isNative' in nativeModule && !(nativeModule as any).isNative)) {
      throw new Error('Secure credential storage is unavailable in this build.');
    }
    await nativeModule.setSecureValue(secureKey, value);
    return;
  }
  await AsyncStorage.setItem(legacyKey, value);
};

export const deleteSavedCredential = async (
  secureKey: string,
  legacyKey: string,
): Promise<void> => {
  if (isReleaseTransport) {
    const mod = loadNativeSecureSocketModule();
    if (mod && 'isNative' in mod && !(mod as any).isNative) return;
    await mod?.deleteSecureValue(secureKey);
    // Also purge any legacy plaintext copy.
    await AsyncStorage.removeItem(legacyKey).catch(() => {});
    return;
  }
  await AsyncStorage.removeItem(legacyKey);
};
