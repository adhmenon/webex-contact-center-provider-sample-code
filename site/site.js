const root = document.documentElement;
const body = document.body;
const themeToggle = document.querySelector('#theme-toggle');
const menuToggle = document.querySelector('#menu-toggle');
const navigation = document.querySelector('#guide-navigation');
const navigationClose = document.querySelector('#navigation-close');
const navigationScrim = document.querySelector('#navigation-scrim');
const searchInput = document.querySelector('#guide-search');
const searchStatus = document.querySelector('#search-status');
const tocLinks = [...document.querySelectorAll('.toc-link')];
const backToTop = document.querySelector('#back-to-top');
const progress = document.querySelector('.reading-progress span');

function updateThemeLabel() {
  const nextTheme = root.dataset.theme === 'dark' ? 'light' : 'dark';
  themeToggle?.setAttribute('aria-label', `Switch to ${nextTheme} theme`);
}

themeToggle?.addEventListener('click', () => {
  root.dataset.theme = root.dataset.theme === 'dark' ? 'light' : 'dark';
  localStorage.setItem('byova-theme', root.dataset.theme);
  updateThemeLabel();
});
updateThemeLabel();

function setNavigation(open) {
  body.dataset.navigationOpen = open ? 'true' : 'false';
  menuToggle?.setAttribute('aria-expanded', String(open));
  menuToggle?.setAttribute('aria-label', open ? 'Close guide navigation' : 'Open guide navigation');
  navigation?.setAttribute('aria-hidden', String(!open && matchMedia('(max-width: 980px)').matches));
  if (open) {
    searchInput?.focus();
  } else {
    menuToggle?.focus();
  }
}

menuToggle?.addEventListener('click', () => setNavigation(true));
navigationClose?.addEventListener('click', () => setNavigation(false));
navigationScrim?.addEventListener('click', () => setNavigation(false));

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && body.dataset.navigationOpen === 'true') {
    setNavigation(false);
  }
});

const searchableSections = tocLinks.map((link) => {
  const section = document.querySelector(link.hash);
  const content = [];
  let current = section;
  while (current) {
    if (current !== section && /^H[23]$/.test(current.tagName)) break;
    content.push(current.textContent || '');
    current = current.nextElementSibling;
  }
  return {
    link,
    item: link.closest('li'),
    text: content.join(' ').toLocaleLowerCase(),
  };
});

searchInput?.addEventListener('input', () => {
  const query = searchInput.value.trim().toLocaleLowerCase();
  let visible = 0;
  for (const section of searchableSections) {
    const matches = !query || section.text.includes(query);
    section.item.hidden = !matches;
    if (matches) visible += 1;
  }
  searchStatus.textContent = query
    ? `${visible} ${visible === 1 ? 'section' : 'sections'} found`
    : '';
});

for (const link of tocLinks) {
  link.addEventListener('click', () => {
    if (matchMedia('(max-width: 980px)').matches) {
      setNavigation(false);
    }
  });
}

const observedHeadings = tocLinks
  .map((link) => document.querySelector(link.hash))
  .filter(Boolean);

const sectionObserver = new IntersectionObserver(
  (entries) => {
    const visible = entries
      .filter((entry) => entry.isIntersecting)
      .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
    if (visible.length === 0) return;
    const activeId = visible[0].target.id;
    for (const link of tocLinks) {
      if (link.hash === `#${activeId}`) {
        link.setAttribute('aria-current', 'location');
      } else {
        link.removeAttribute('aria-current');
      }
    }
  },
  { rootMargin: '-15% 0px -72% 0px', threshold: 0 },
);
observedHeadings.forEach((heading) => sectionObserver.observe(heading));

for (const pre of document.querySelectorAll('pre')) {
  const wrapper = document.createElement('div');
  wrapper.className = 'code-block';
  pre.before(wrapper);
  wrapper.append(pre);

  const button = document.createElement('button');
  button.className = 'copy-code';
  button.type = 'button';
  button.textContent = 'Copy';
  button.setAttribute('aria-label', 'Copy code to clipboard');
  button.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(pre.textContent || '');
      button.textContent = 'Copied';
      setTimeout(() => { button.textContent = 'Copy'; }, 1600);
    } catch {
      button.textContent = 'Select code';
      const selection = getSelection();
      const range = document.createRange();
      range.selectNodeContents(pre);
      selection?.removeAllRanges();
      selection?.addRange(range);
    }
  });
  wrapper.append(button);
}

let ticking = false;
function updateScrollState() {
  const scrollable = document.documentElement.scrollHeight - innerHeight;
  const ratio = scrollable > 0 ? Math.min(1, scrollY / scrollable) : 0;
  progress.style.transform = `scaleX(${ratio})`;
  backToTop.dataset.visible = String(scrollY > 800);
  ticking = false;
}

addEventListener('scroll', () => {
  if (!ticking) {
    requestAnimationFrame(updateScrollState);
    ticking = true;
  }
}, { passive: true });
updateScrollState();

backToTop?.addEventListener('click', () => {
  scrollTo({ top: 0, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
});

function syncNavigationForViewport() {
  const mobile = matchMedia('(max-width: 980px)').matches;
  if (!mobile) {
    body.dataset.navigationOpen = 'false';
    navigation?.removeAttribute('aria-hidden');
    menuToggle?.setAttribute('aria-expanded', 'false');
    menuToggle?.setAttribute('aria-label', 'Open guide navigation');
  } else if (body.dataset.navigationOpen !== 'true') {
    navigation?.setAttribute('aria-hidden', 'true');
  }
}

addEventListener('resize', syncNavigationForViewport);
syncNavigationForViewport();
