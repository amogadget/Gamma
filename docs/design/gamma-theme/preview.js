const root = document.documentElement;
function update() {
  for (const kind of ['palette', 'theme']) {
    document.querySelectorAll(`[data-${kind}-choice]`).forEach(button => {
      button.setAttribute('aria-pressed', String(button.dataset[`${kind}Choice`] === root.dataset[kind]));
    });
  }
  const style = getComputedStyle(root);
  document.querySelectorAll('[data-token]').forEach(label => {
    label.textContent = style.getPropertyValue(label.dataset.token).trim();
  });
}
document.querySelectorAll('[data-palette-choice], [data-theme-choice]').forEach(button => {
  button.addEventListener('click', () => {
    if (button.dataset.paletteChoice) root.dataset.palette = button.dataset.paletteChoice;
    if (button.dataset.themeChoice) root.dataset.theme = button.dataset.themeChoice;
    update();
  });
});
document.getElementById('ask-button').addEventListener('click', () => {
  document.getElementById('preview-message').hidden = false;
});
update();
