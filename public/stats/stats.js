/* KuroNeko Stats — performant polling.
   DOM refs are cached, textContent avoids forced reflow, hidden tabs skip work,
   and a recursive timeout prevents overlapping requests. */
const revealObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add('in');
        revealObserver.unobserve(entry.target);
    }
}, { threshold: 0.08 });
document.querySelectorAll('.reveal').forEach((el) => revealObserver.observe(el));

const UPDATE_INTERVAL = 1000;
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const el = (id) => document.getElementById(id);

const nodes = {
    uptime: el('uptime'),
    platform: el('platform'),
    arch: el('arch'),
    nodeVer: el('node-ver'),
    cpuModel: el('cpu-model'),
    cpuLoad: el('cpu-load'),
    memUsed: el('mem-used'),
    memTotal: el('mem-total'),
    memFree: el('mem-free'),
    ramBar: el('ram-bar'),
    ramPct: el('ram-percent')
};

const setText = (node, value) => {
    if (node && node.textContent !== value) node.textContent = value;
};

let inFlight = false;
let timer = null;

async function fetchStats() {
    if (inFlight || document.hidden) return;
    inFlight = true;
    try {
        const response = await fetch('/stats/data', { headers: { Accept: 'application/json' } });
        if (!response.ok) return;
        const data = await response.json();
        if (!data.status) return;

        const s = data.server;
        setText(nodes.uptime, s.uptime);
        setText(nodes.platform, s.hostname);
        setText(nodes.arch, s.arch);
        setText(nodes.nodeVer, s.node_version);
        setText(nodes.cpuModel, `${s.cpu.model} (${s.cpu.cores} Cores)`);
        setText(nodes.cpuLoad, `${(parseFloat(s.cpu.load) * 10).toFixed(1)}%`);
        setText(nodes.memUsed, s.memory.used);
        setText(nodes.memTotal, s.memory.total);
        setText(nodes.memFree, s.memory.free);

        const pct = s.memory.percent;
        setText(nodes.ramPct, `${pct}%`);
        if (nodes.ramBar) {
            const width = `${pct}%`;
            if (nodes.ramBar.style.width !== width) {
                nodes.ramBar.style.width = width;
                if (!reducedMotion) nodes.ramBar.style.transition = 'width 0.6s cubic-bezier(0.34, 1.2, 0.64, 1)';
            }
            if (pct > 90) {
                nodes.ramBar.classList.add('danger');
                nodes.ramBar.classList.remove('warn');
            } else if (pct > 70) {
                nodes.ramBar.classList.add('warn');
                nodes.ramBar.classList.remove('danger');
            } else {
                nodes.ramBar.classList.remove('warn', 'danger');
            }
        }
    } catch {
        /* keep last known values on transient failure */
    } finally {
        inFlight = false;
    }
}

function schedule() {
    timer = setTimeout(() => {
        fetchStats().finally(schedule);
    }, document.hidden ? UPDATE_INTERVAL * 5 : UPDATE_INTERVAL);
}

fetchStats();
schedule();

document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    if (timer) clearTimeout(timer);
    fetchStats().finally(schedule);
});
