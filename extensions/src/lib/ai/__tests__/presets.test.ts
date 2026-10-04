import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../../constants';
import { groqVisionPreset, GROQ_BASE_URL, GROQ_VISION_MODEL } from '../presets';

describe('Groq Vision preset', () => {
  it('selects a compatible endpoint without carrying another provider key or enabling cloud OCR', () => {
    const current = { ...DEFAULT_SETTINGS, customAiBaseUrl: 'https://another.test/v1', customAiApiKey: 'foreign-secret' };
    const patch = groqVisionPreset(current);
    expect(patch).toEqual({ model: 'custom', customAiBaseUrl: GROQ_BASE_URL, customAiModel: GROQ_VISION_MODEL, customAiApiKey: '' });
    expect(current.customAiApiKey).toBe('foreign-secret');
    expect(patch).not.toHaveProperty('engine'); expect(patch).not.toHaveProperty('cloudOcr');
    expect(patch).not.toHaveProperty('geminiApiKey');
  });
  it('retains an existing Groq key only for the exact same provider', () => {
    expect(groqVisionPreset({ ...DEFAULT_SETTINGS, customAiBaseUrl: GROQ_BASE_URL + '/', customAiApiKey: 'own-key' }).customAiApiKey).toBe('own-key');
    expect(groqVisionPreset({ ...DEFAULT_SETTINGS, customAiBaseUrl: GROQ_BASE_URL + '.evil', customAiApiKey: 'other-key' }).customAiApiKey).toBe('');
  });
});
