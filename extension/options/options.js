// Loads and saves the two settings using Chrome's storage.
const $ = (id) => document.getElementById(id);

// Show current values when the page opens
chrome.storage.sync
  .get({ webhookBase: 'http://localhost:5678', secret: '' })
  .then((s) => { $('webhookBase').value = s.webhookBase; $('secret').value = s.secret; });

// Save on click
$('save').addEventListener('click', async () => {
  await chrome.storage.sync.set({
    webhookBase: $('webhookBase').value.trim().replace(/\/+$/, ''), // strip trailing /
    secret: $('secret').value.trim(),
  });
  $('saved').textContent = '✅ Saved';
  setTimeout(() => ($('saved').textContent = ''), 1500);
});
