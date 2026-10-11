import AsyncStorage from '@react-native-async-storage/async-storage';

let SecureStore: any = null;
try {
  SecureStore = require('expo-secure-store');
} catch (_) {}

export const SECURE_KEYS_STORAGE_KEY = 'blinky_mobile_api_keys_v2';
export const ASYNC_KEYS_FALLBACK_KEY = '@blinky_mobile_api_keys';

export interface SyncedApiKeys {
  groq_key?: string;
  openai_key?: string;
  gemini_key?: string;
  deepseek_key?: string;
}

async function isSecureAvailable(): Promise<boolean> {
  try {
    if (!SecureStore) return false;
    return await SecureStore.isAvailableAsync().catch(() => false);
  } catch {
    return false;
  }
}

/**
 * Persists BYOK API keys from PC Blinky in hardware-backed storage only
 * (Android Keystore / iOS Keychain via SecureStore).
 *
 * Fail-closed: when SecureStore is unavailable (e.g. Expo Go) keys are NOT
 * written to plaintext AsyncStorage. Any legacy plaintext copy is purged.
 */
export async function saveSyncedApiKeys(keys: SyncedApiKeys): Promise<void> {
  const secure = await isSecureAvailable();
  if (!secure) {
    console.warn('[SecureKeys] SecureStore unavailable — refusing to persist API keys in plaintext. Purging legacy fallback copy.');
    await AsyncStorage.removeItem(ASYNC_KEYS_FALLBACK_KEY).catch(() => {});
    return;
  }
  try {
    const payload = JSON.stringify(keys);
    await SecureStore.setItemAsync(SECURE_KEYS_STORAGE_KEY, payload, {
      keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
    });
    // Purge any lingering plaintext fallback copy once hardware keystore succeeds
    await AsyncStorage.removeItem(ASYNC_KEYS_FALLBACK_KEY).catch(() => {});
    console.log('[SecureKeys] API Keys securely encrypted in hardware keystore.');
  } catch (err) {
    console.warn('[SecureKeys] Error saving encrypted API keys on mobile:', err);
    // Never fall back to plaintext on write failure.
  }
}

/**
 * Retrieves stored keys from SecureStore only. Performs a one-time migration:
 * if a legacy AsyncStorage copy exists and SecureStore is available, it is
 * moved into SecureStore then deleted. Plaintext is never used as a persistent store.
 */
export async function getSyncedApiKeys(): Promise<SyncedApiKeys> {
  try {
    const secure = await isSecureAvailable();
    if (secure) {
      const data = await SecureStore.getItemAsync(SECURE_KEYS_STORAGE_KEY).catch(() => null);
      if (data) {
        // Opportunistically purge any legacy plaintext copy.
        await AsyncStorage.removeItem(ASYNC_KEYS_FALLBACK_KEY).catch(() => {});
        return JSON.parse(data) as SyncedApiKeys;
      }
      // One-time migration from legacy plaintext copy.
      const legacy = await AsyncStorage.getItem(ASYNC_KEYS_FALLBACK_KEY).catch(() => null);
      if (legacy) {
        try {
          const parsed = JSON.parse(legacy) as SyncedApiKeys;
          await SecureStore.setItemAsync(SECURE_KEYS_STORAGE_KEY, JSON.stringify(parsed), {
            keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
          });
        } catch {}
        await AsyncStorage.removeItem(ASYNC_KEYS_FALLBACK_KEY).catch(() => {});
        const moved = await SecureStore.getItemAsync(SECURE_KEYS_STORAGE_KEY).catch(() => null);
        if (moved) return JSON.parse(moved) as SyncedApiKeys;
      }
      return {};
    }
    return {};
  } catch (err) {
    console.warn('[SecureKeys] Error loading encrypted API keys on mobile:', err);
    return {};
  }
}

/**
 * Checks if at least one valid cloud API key is available for offline mobile queries.
 */
export async function hasSyncedApiKeys(): Promise<boolean> {
  const keys = await getSyncedApiKeys();
  return Boolean(keys.groq_key || keys.openai_key || keys.gemini_key || keys.deepseek_key);
}

/**
 * Completely purges synced API keys from both SecureStore and AsyncStorage on disconnect/logout.
 */
export async function clearSyncedApiKeys(): Promise<void> {
  try {
    const secure = await isSecureAvailable();
    if (secure) {
      await SecureStore.deleteItemAsync(SECURE_KEYS_STORAGE_KEY).catch(() => {});
    }
    await AsyncStorage.removeItem(ASYNC_KEYS_FALLBACK_KEY).catch(() => {});
    console.log('[SecureKeys] Synced API keys successfully purged from mobile storage.');
  } catch (err) {
    console.warn('[SecureKeys] Error clearing synced API keys:', err);
  }
}
