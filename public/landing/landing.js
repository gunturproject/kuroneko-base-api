/* KuroNeko Landing — instant paint.
   Content is revealed synchronously; /config only enriches it in the
   background, so a slow lambda can never block first paint. */
const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function share(){
    if(navigator.share){
        navigator.share({title:document.title,url:window.location.href}).catch(()=>{});
    }else{
        navigator.clipboard.writeText(window.location.href);
        const icon=document.getElementById('share-icon');
        const original=icon.innerHTML;
        icon.innerHTML='<path d="M5 12l4 4L19 6" stroke-linecap="round" stroke-linejoin="round"/>';
        setTimeout(()=>{icon.innerHTML=original},1500);
    }
}

function initReveal(){
    const items=document.querySelectorAll('.reveal');

    if(prefersReducedMotion || !('IntersectionObserver' in window)){
        items.forEach(el=>el.classList.add('in'));
        return;
    }

    const observer=new IntersectionObserver((entries)=>{
        for(const entry of entries){
            if(!entry.isIntersecting) continue;
            entry.target.classList.add('in');
            observer.unobserve(entry.target);
        }
    },{threshold:.1});

    items.forEach(el=>observer.observe(el));
}

function openSidebar(){
    document.getElementById('sidebar').classList.add('open');
    document.getElementById('sidebar-overlay').classList.add('show');
    document.getElementById('menu-toggle').setAttribute('aria-expanded','true');
    document.getElementById('sidebar').setAttribute('aria-hidden','false');
    document.body.style.overflow='hidden';
}

function closeSidebar(){
    document.getElementById('sidebar').classList.remove('open');
    document.getElementById('sidebar-overlay').classList.remove('show');
    document.getElementById('menu-toggle').setAttribute('aria-expanded','false');
    document.getElementById('sidebar').setAttribute('aria-hidden','true');
    document.body.style.overflow='';
}

document.getElementById('menu-toggle').addEventListener('click',openSidebar);
document.getElementById('sidebar-close').addEventListener('click',closeSidebar);
document.getElementById('sidebar-overlay').addEventListener('click',closeSidebar);
document.addEventListener('keydown',(e)=>{ if(e.key==='Escape') closeSidebar(); });

/* Reveal immediately — no API gate, no artificial timer. */
document.getElementById('loader').classList.add('hidden');
document.getElementById('content').classList.remove('hidden');
initReveal();

/* Progressive enhancement: fill in live config whenever it arrives. */
fetch('/config')
    .then(res=>res.ok ? res.json() : null)
    .then(config=>{
        if(!config?.settings) return;
        const s=config.settings;

        const setText=(id,value)=>{
            if(value==null) return;
            const node=document.getElementById(id);
            if(node && node.textContent!==value) node.textContent=value;
        };

        setText('dash-title',s.apiName);
        setText('dash-desc',s.description);
        setText('header-name',s.apiName);
        setText('sidebar-name',s.apiName);

        const btnChannel=document.getElementById('btn-channel');
        if(btnChannel){
            if(s.channelUrl) btnChannel.href=s.channelUrl;
            else btnChannel.style.display='none';
        }

        const btnSource=document.getElementById('btn-source');
        if(btnSource){
            if(s.github) btnSource.href=s.github;
            else btnSource.style.display='none';
        }

        const thumbEl=document.getElementById('dash-thumb');
        if(thumbEl && s.thumbnail && thumbEl.src!==s.thumbnail){
            thumbEl.onerror=()=>{ thumbEl.onerror=null; };
            thumbEl.src=s.thumbnail;
        }

        const headerLogo=document.getElementById('header-logo');
        const sidebarLogo=document.getElementById('sidebar-logo');
        if(s.favicon){
            document.getElementById('favicon').href=s.favicon;
            if(headerLogo) headerLogo.src=s.favicon;
            if(sidebarLogo) sidebarLogo.src=s.favicon;
        }
    })
    .catch(()=>{ /* defaults in HTML already cover this */ });
