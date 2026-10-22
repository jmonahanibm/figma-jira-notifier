'use strict';

const { buildNodeLinks } = require('../src/figmaLinks');

describe('buildNodeLinks', () => {
  test('builds app and browser links with colon node id converted to hyphen', () => {
    expect(buildNodeLinks('Oz2jhWJvnONkoqbPVN0E5y', 'test', '1:86')).toEqual({
      app: 'figma://file/Oz2jhWJvnONkoqbPVN0E5y/test?node-id=1-86',
      browser: 'https://www.figma.com/design/Oz2jhWJvnONkoqbPVN0E5y/test?node-id=1-86'
    });
  });

  test('replaces spaces in the file name with hyphens', () => {
    const { app, browser } = buildNodeLinks('KEY', 'My Product Design', '1:2');
    expect(app).toBe('figma://file/KEY/My-Product-Design?node-id=1-2');
    expect(browser).toBe('https://www.figma.com/design/KEY/My-Product-Design?node-id=1-2');
  });

  test('collapses runs of whitespace and trims the file name', () => {
    const { browser } = buildNodeLinks('KEY', '  My   Design  ', '1:2');
    expect(browser).toBe('https://www.figma.com/design/KEY/My-Design?node-id=1-2');
  });

  test('URL-encodes special characters in the file name', () => {
    const { browser } = buildNodeLinks('KEY', 'Q&A / v2 #1?', '1:2');
    expect(browser).toBe('https://www.figma.com/design/KEY/Q%26A-%2F-v2-%231%3F?node-id=1-2');
  });

  test('converts multi-part node ids such as instance paths', () => {
    const { browser } = buildNodeLinks('KEY', 'f', 'I12:34;56:78');
    expect(browser).toBe('https://www.figma.com/design/KEY/f?node-id=I12-34%3B56-78');
  });

  test('returns empty links when the file key is missing', () => {
    expect(buildNodeLinks('', 'f', '1:2')).toEqual({ app: '', browser: '' });
  });

  test('omits the file name segment when it is missing', () => {
    const { app, browser } = buildNodeLinks('KEY', '', '1:2');
    expect(app).toBe('figma://file/KEY?node-id=1-2');
    expect(browser).toBe('https://www.figma.com/design/KEY?node-id=1-2');
  });

  test('omits the node-id query when there is no node id', () => {
    const { app, browser } = buildNodeLinks('KEY', 'f', '');
    expect(app).toBe('figma://file/KEY/f');
    expect(browser).toBe('https://www.figma.com/design/KEY/f');
  });
});
