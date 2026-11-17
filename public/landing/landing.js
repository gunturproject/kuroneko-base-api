/* KuroNeko Landing — instant paint.
   Content is revealed synchronously; /config only enriches it in the
   background, so a slow lambda can never block first paint. */
const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function resolveAssetUrl(value){
    try{
        return new URL(value||'',window.location.origin).href;
    }catch{
        return value||'';
    }
}

function playThumbVideo(video){
    let started=video.play();

    if(started&&started.catch){
        started.catch(()=>{
            video.muted=true;
            let fallback=video.play();
            if(fallback&&fallback.catch) fallback.catch(()=>{});

            const unmute=()=>{
                document.removeEventListener('pointerdown',unmute);
                document.removeEventListener('touchstart',unmute);
                document.removeEventListener('keydown',unmute);
                video.muted=false;
                const resumed=video.play();
                if(resumed&&resumed.catch) resumed.catch(()=>{});
            };

            document.addEventListener('pointerdown',unmute,{once:true,passive:true});
            document.addEventListener('touchstart',unmute,{once:true,passive:true});
            document.addEventListener('keydown',unmute,{once:true});
        });
    }
}

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

let _drawerLocked=false;
let _drawerScrollY=0;
function lockBodyScroll(){
    if(_drawerLocked)return;
    _drawerLocked=true;
    _drawerScrollY=window.scrollY||window.pageYOffset||0;
    const s=document.body.style;
    s.position='fixed';
    s.top=`-${_drawerScrollY}px`;
    s.left='0';s.right='0';s.width='100%';s.overflow='hidden';
}
function unlockBodyScroll(){
    if(!_drawerLocked)return;
    _drawerLocked=false;
    const s=document.body.style;
    s.position='';s.top='';s.left='';s.right='';s.width='';s.overflow='';
    window.scrollTo(0,_drawerScrollY);
}

function openSidebar(){
    document.getElementById('sidebar').classList.add('open');
    document.getElementById('sidebar-overlay').classList.add('show');
    document.getElementById('menu-toggle').setAttribute('aria-expanded','true');
    document.getElementById('sidebar').setAttribute('aria-hidden','false');
    lockBodyScroll();
}

function closeSidebar(){
    document.getElementById('sidebar').classList.remove('open');
    document.getElementById('sidebar-overlay').classList.remove('show');
    document.getElementById('menu-toggle').setAttribute('aria-expanded','false');
    document.getElementById('sidebar').setAttribute('aria-hidden','true');
    unlockBodyScroll();
}

document.getElementById('menu-toggle').addEventListener('click',openSidebar);
document.getElementById('sidebar-close').addEventListener('click',closeSidebar);
document.getElementById('sidebar-overlay').addEventListener('click',closeSidebar);
document.addEventListener('keydown',(e)=>{ if(e.key==='Escape') closeSidebar(); });

/* Reveal immediately — no API gate, no artificial timer. */
document.getElementById('loader').classList.add('hidden');
document.getElementById('content').classList.remove('hidden');
initReveal();

const initialThumb=document.getElementById('dash-thumb');
if(initialThumb&&initialThumb.tagName==='VIDEO') playThumbVideo(initialThumb);

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
        if(thumbEl && s.thumbnail){
            const next=resolveAssetUrl(s.thumbnail);
            const cur=resolveAssetUrl(thumbEl.getAttribute('src')||'');
            if(cur!==next){
                thumbEl.onerror=()=>{ thumbEl.onerror=null; };
                thumbEl.src=s.thumbnail;
                if(thumbEl.tagName==='VIDEO'){
                    thumbEl.load();
                    playThumbVideo(thumbEl);
                }
            }
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
