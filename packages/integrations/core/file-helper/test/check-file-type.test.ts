/// <reference types="vitest/globals" />

import { checkFileType } from '../src/lib/actions/check-file-type';
import { createMockActionContext, ApFile } from '@inboxfm-connect/pieces-framework';

describe('checkFileType', () => {
  test('single-select value: matches the exact MIME type', async () => {
    const file = new ApFile('photo.png', Buffer.from('fake-png'), 'png');
    const ctx = createMockActionContext({
      propsValue: {
        file,
        mimeTypes: 'image/png',
      },
    });
    const result = await checkFileType.run(ctx);
    expect(result).toEqual({
      mimeType: 'image/png',
      isMatch: true,
    });
  });

  test('single-select value: does not match a different MIME type', async () => {
    const file = new ApFile('doc.pdf', Buffer.from('fake-pdf'), 'pdf');
    const ctx = createMockActionContext({
      propsValue: {
        file,
        mimeTypes: 'image/png',
      },
    });
    const result = await checkFileType.run(ctx);
    expect(result).toEqual({
      mimeType: 'application/pdf',
      isMatch: false,
    });
  });

  test('single-select value: substring of the selection is not a match (#557)', async () => {
    // `mimeTypes` is a Property.StaticDropdown — a single string at runtime.
    // Regression: 'video/3gpp2'.includes('video/3gpp') was true, so a .3gp
    // file wrongly passed a video/3gpp2 filter.
    const file = new ApFile('video.3gp', Buffer.from('fake-3gp'), '3gp');
    const ctx = createMockActionContext({
      propsValue: {
        file,
        mimeTypes: 'video/3gpp2',
      },
    });
    const result = await checkFileType.run(ctx);
    expect(result).toEqual({
      mimeType: 'video/3gpp',
      isMatch: false,
    });
  });

  test('multi-select value: matches one of the selected MIME types', async () => {
    // Forward-compat: a future multi-select dropdown delivers an array.
    const file = new ApFile('photo.png', Buffer.from('fake-png'), 'png');
    const ctx = createMockActionContext({
      propsValue: {
        file,
        mimeTypes: ['image/png', 'image/jpeg'],
      },
    });
    const result = await checkFileType.run(ctx);
    expect(result).toEqual({
      mimeType: 'image/png',
      isMatch: true,
    });
  });

  test('multi-select value: does not match unselected MIME types', async () => {
    const file = new ApFile('doc.pdf', Buffer.from('fake-pdf'), 'pdf');
    const ctx = createMockActionContext({
      propsValue: {
        file,
        mimeTypes: ['image/png', 'image/jpeg'],
      },
    });
    const result = await checkFileType.run(ctx);
    expect(result).toHaveProperty('isMatch', false);
  });

  test('multi-select value: substring entries are not a match (#557)', async () => {
    const file = new ApFile('video.3gp', Buffer.from('fake-3gp'), '3gp');
    const ctx = createMockActionContext({
      propsValue: {
        file,
        mimeTypes: ['video/3gpp2', 'video/mp4'],
      },
    });
    const result = await checkFileType.run(ctx);
    expect(result).toHaveProperty('isMatch', false);
  });
});
