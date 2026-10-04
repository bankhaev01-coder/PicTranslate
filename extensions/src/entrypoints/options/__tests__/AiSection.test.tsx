// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
const permissions = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('wxt/browser', () => ({ browser: { permissions } }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
import AiSection from '../AiSection';
import { DEFAULT_SETTINGS } from '../../../lib/constants';
import { GROQ_BASE_URL, GROQ_VISION_MODEL } from '../../../lib/ai/presets';
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { if (root) act(() => root?.unmount()); document.body.replaceChildren(); vi.clearAllMocks(); });

describe('Groq opt-in UI', () => {
  it('selects the preset only after a click and does not grant permission or send images', () => {
    const container = document.createElement('div'); document.body.append(container); root = createRoot(container);
    const patch = vi.fn();
    act(() => root!.render(<AiSection settings={{ ...DEFAULT_SETTINGS, customAiBaseUrl: 'https://other.test/v1', customAiApiKey: 'foreign' }} patch={patch} />));
    expect(patch).not.toHaveBeenCalled(); expect(permissions.request).not.toHaveBeenCalled();
    const button = Array.from(container.querySelectorAll('button')).find(b => b.textContent === 'options.groqPreset')!;
    act(() => button.click());
    expect(patch).toHaveBeenCalledExactlyOnceWith({ model: 'custom', customAiBaseUrl: GROQ_BASE_URL,
      customAiModel: GROQ_VISION_MODEL, customAiApiKey: '' });
    expect(permissions.request).not.toHaveBeenCalled();
  });
});
