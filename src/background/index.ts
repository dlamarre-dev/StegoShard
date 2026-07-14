/**
 * Service worker (Chrome/Edge) / background script (Firefox).
 *
 * Its only job is to open the full-page app when the toolbar icon is clicked;
 * all cryptography, encoding, and rendering happen in the app pages.
 */

import browser from 'webextension-polyfill';

const APP_URL = 'ui/app.html';

// Clicking the toolbar icon opens the full-page app in a tab (there is no popup).
browser.action.onClicked.addListener(() => {
  void browser.tabs.create({ url: browser.runtime.getURL(APP_URL) });
});
