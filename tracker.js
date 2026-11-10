/* IELTS tracker: SVG button next to the profile -> fullscreen view with a "Главное меню" back button.
   The tracker itself is tracker.html (own file, own styles, its data stays in this browser's localStorage). */
(function(){
  const fab = document.getElementById('trackerFab');
  if(!fab) return;
  let view = null;
  function build(){
    view = document.createElement('div');
    view.id = 'trackerView';
    view.innerHTML =
      '<div class="tv-bar">' +
        '<button class="tv-back" id="trackerBack" type="button" aria-label="Назад в главное меню">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>' +
          '<span>Главное меню</span>' +
        '</button>' +
        '<div class="tv-title">IELTS Трекер</div>' +
      '</div>' +
      '<iframe class="tv-frame" title="IELTS Трекер"></iframe>';
    document.body.appendChild(view);
    view.querySelector('#trackerBack').addEventListener('click', close);
  }
  function open(){
    if(!view) build();
    const fr = view.querySelector('iframe');
    if(!fr.getAttribute('src')) fr.setAttribute('src', 'tracker.html'); // loaded only when first opened
    view.classList.add('open');
    document.body.classList.add('tracker-open');
  }
  function close(){
    if(!view) return;
    view.classList.remove('open');
    document.body.classList.remove('tracker-open');
  }
  fab.addEventListener('click', open);
  document.addEventListener('keydown', e => { if(e.key === 'Escape' && view && view.classList.contains('open')) close(); });
})();
