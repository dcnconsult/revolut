const search = document.querySelector('#guide-search');
const status = document.querySelector('#search-status');
const sections = [...document.querySelectorAll('[data-guide-section]')];
const noResults = document.querySelector('#no-results');

function normalize(value) {
  return value.toLocaleLowerCase().trim();
}

function filterGuide() {
  const query = normalize(search.value);
  let visible = 0;
  for (const section of sections) {
    const haystack = normalize(`${section.dataset.search ?? ''} ${section.textContent ?? ''}`);
    const matches = !query || haystack.includes(query);
    section.hidden = !matches;
    if (matches) visible += 1;
  }
  noResults.hidden = visible !== 0;
  status.textContent = query ? `${visible} guide section${visible === 1 ? '' : 's'} found` : '';
}

search.addEventListener('input', filterGuide);
document.querySelector('#print-guide').addEventListener('click', () => window.print());

const links = [...document.querySelectorAll('nav a')];
const observer = new IntersectionObserver(entries => {
  const visible = entries
    .filter(entry => entry.isIntersecting)
    .sort((left, right) => right.intersectionRatio - left.intersectionRatio)[0];
  if (!visible) return;
  for (const link of links) {
    link.classList.toggle('active', link.getAttribute('href') === `#${visible.target.id}`);
  }
}, { rootMargin: '-15% 0px -70% 0px', threshold: [0.05, 0.25, 0.5] });

for (const section of sections) observer.observe(section);
