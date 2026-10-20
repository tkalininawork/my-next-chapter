/* Личный кабинет. В облачном режиме данные хранятся в Supabase под RLS,
   обновляются через атомарный revision-check RPC, резервная копия — JSON. */
(() => {
  'use strict';
  const root = document.getElementById('app');
  const CFG = window.NEXT_CHAPTER_CONFIG || {};
  const HAS_CLOUD = !!(CFG.supabaseUrl && CFG.supabaseAnonKey);
  const LOCAL_KEY = 'my-next-chapter-local-v1'; // НЕ менять: иначе локальные данные останутся в прежнем ключе
  const sections = [{id:'today',icon:'☀',title:'Сегодня'},{id:'weeks',icon:'▦',title:'Неделя'},{id:'strategy',icon:'◇',title:'Стратегия'},{id:'tasks',icon:'✓',title:'Шаги'},{id:'finances',icon:'€',title:'Деньги'},{id:'review',icon:'◴',title:'Ретроспектива'},{id:'projects',icon:'▤',title:'Проекты'},{id:'english',icon:'A',title:'IELTS'}];
  const today = () => {const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`};
  const blank = () => ({schemaVersion:1,goals:[],groups:[],quarters:[],weeks:[],tasks:[],finances:[],daily:{},reviews:{},plannedDays:{},transactions:[],projects:[]});
  const getLocal = () => {try {let x=JSON.parse(localStorage.getItem(LOCAL_KEY));return normalize(x)}catch{return blank()}};
  const normalize = x => {
    const z = x && typeof x==='object' && !Array.isArray(x) ? x : {};
    return {...blank(), ...z, goals:Array.isArray(z.goals)?z.goals:[],groups:Array.isArray(z.groups)?z.groups:[],quarters:Array.isArray(z.quarters)?z.quarters:[],weeks:Array.isArray(z.weeks)?z.weeks:[],tasks:Array.isArray(z.tasks)?z.tasks:[],finances:Array.isArray(z.finances)?z.finances:[],daily:z.daily&&typeof z.daily==='object'?z.daily:{},reviews:z.reviews&&typeof z.reviews==='object'?z.reviews:{},plannedDays:z.plannedDays&&typeof z.plannedDays==='object'?z.plannedDays:{},transactions:Array.isArray(z.transactions)?z.transactions:[],projects:Array.isArray(z.projects)?z.projects:[]};
  };
  let data = HAS_CLOUD ? blank() : getLocal();
  let api=null, session=null, revision=0, mode=HAS_CLOUD?'loading':'local', view='today', currentWeek=-1;
  let pendingPatch=null, voiceDraft='', voiceRecognition=null;
  let modal=null, taskFilter='Все', goalFilter='Все', projectFilter='Все', selectedReviewMonth=today().slice(0,7), selectedDailyDate=today(), authMode='login', syncState=HAS_CLOUD?'Подключение…':'Только на этом устройстве';
  let saveTimer=null, isSaving=false, localChanges=0, dirty=false, conflict=false, toastTimer=null, listening=null;
  const $ = id => document.getElementById(id);
  const h = v => String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const attr=h;
  const first = (s,n) => (s||'').length>n?s.slice(0,n-1)+'…':s;
  const nice = s => {if(!s)return '—';let d=new Date(s+'T12:00:00');return d.toLocaleDateString('ru-RU',{day:'numeric',month:'long',year:'numeric'})};
  const niceShort = s => {if(!s)return '—';let d=new Date(s+'T12:00:00');return d.toLocaleDateString('ru-RU',{day:'numeric',month:'short'})};
  const dateLocal = s => new Date(s+'T12:00:00');
  const monthTitle = s => { if(!s)return '—';let d = new Date(s+'-01T12:00:00');return d.toLocaleDateString('ru-RU',{month:'long',year:'numeric'})};
  const euro = x => x==null||!Number.isFinite(Number(x))?'—':Number(x).toLocaleString('ru-RU',{maximumFractionDigits:0})+' €';
  const pill = (v) => `<span class="pill ${v==='Готово'?'':v==='В работе'||v==='Делаю'?'blue':v==='Пауза'?'peach':'gray'}">${h(v||'В планах')}</span>`;
  const button = (name,text,extra='') => `<button type="button" class="button ${extra}" data-action="${name}">${text}</button>`;
  function statusClass(){return !HAS_CLOUD?'off':(conflict||syncState.includes('Ошибка'))?'bad':(mode==='ready'?'':'off')}
  function getWeekIndex(){ if(!data.weeks.length)return -1;if(currentWeek>=0)return Math.min(currentWeek,data.weeks.length-1);let t=today();let ix=data.weeks.findIndex(w=>w.start<=t&&w.end>=t); if(ix!==-1)return ix;return t>data.weeks.at(-1).end?data.weeks.length-1:0; }
  function week(){const i=getWeekIndex();return i<0?null:data.weeks[i];}
  function day(){return data.daily[today()]||{energy:'обычно',main:'',fallback:'',extra:'',care:'',note:'',taskIds:[]}}
  // История использует те же дневные записи. Никакого отдельного хранилища или переноса данных.
  function hasDailyContent(d){
    return d && (['main','fallback','extra','care','note'].some(k=>String(d[k]||'').trim()) ||
      (Array.isArray(d.taskIds)&&d.taskIds.length>0) ||
      (Array.isArray(d.completedSuggestions)&&d.completedSuggestions.length>0) ||
      (d.energy&&d.energy!=='обычно'));
  }
  function dailyDates(){return Object.keys(data.daily).filter(k=>validISO(k)&&k<=today()&&hasDailyContent(data.daily[k])).sort().reverse()}
  function dailySaveStatus(){return `<div class="daily-save-status" role="status" aria-live="polite"><span data-sync-dot class="sync-dot ${statusClass()}"></span><span data-sync-label>${h(syncState)}</span><span class="daily-save-hint">· автоматически</span></div>`}
  function dailyNavigation(){
    const t=today(),past=selectedDailyDate!==t,dates=dailyDates(),after=dates.filter(k=>k!==selectedDailyDate);
    const next=dateLocal(selectedDailyDate);next.setDate(next.getDate()+1);
    return `<section class="panel daily-history-nav"><div class="daily-history-heading"><div><div class="eyebrow">ДНЕВНЫЕ ЗАПИСИ</div><h3>${past?'Записи за '+nice(selectedDailyDate):'Сегодня, '+nice(t)}</h3><p class="muted small">Все дни остаются в истории. Можно вернуться к любой дате.</p></div><span class="pill ${past?'blue':'lilac'}">${past?'Прошлый день':'Сегодня'}</span></div>
      <div class="daily-history-controls">
      <button type="button" class="button sm" data-action="prev-day" aria-label="Предыдущий день">← Назад</button>
      <label class="daily-date-field"><span class="small muted">Дата</span><input type="date" class="input" data-bind="history-date" value="${attr(selectedDailyDate)}" max="${t}" aria-label="Дата дневной записи"></label>
      <button type="button" class="button sm" data-action="next-day" ${todayFromDate(next)>t?'disabled':''}>Вперёд →</button>
      <button type="button" class="button sm ${past?'primary':''}" data-action="go-today" ${!past?'disabled':''}>Сегодня</button>
      </div>
      ${dates.length?`<label class="daily-saved-select"><span class="small muted">Или выбери день с записями</span><select class="select" data-bind="saved-day"><option value="">Выбрать из истории…</option>${dates.map(k=>`<option value="${k}" ${k===selectedDailyDate?'selected':''}>${nice(k)}</option>`).join('')}</select></label>`:''}
    </section>`;
  }
  function archiveField(label,key,placeholder,d){return `<div class="field"><label class="field-label" for="archive-${key}">${label}</label><textarea id="archive-${key}" class="textarea compact" data-bind="archive:${key}" placeholder="${attr(placeholder)}">${h(d[key]||'')}</textarea></div>`}
  function renderDailyArchive(){
    const k=selectedDailyDate,d=data.daily[k]||{},selected=(d.taskIds||[]).map(id=>data.tasks.find(t=>t.id===id)).filter(Boolean);
    let out=contentHeader('Дневные записи',`Здесь сохранилось то, что ты планировала и замечала ${nice(k)}.`, 'МОЯ СЛЕДУЮЩАЯ ГЛАВА')+syncWarning()+dailyNavigation();
    out+=`<div class="notice daily-archive-note">Ты смотришь ${nice(k)}. Изменения в полях сохраняются именно за эту дату. Задачи и их нынешние статусы здесь не меняются.</div>`;
    if(!hasDailyContent(d))out+=`<div class="empty" style="margin-bottom:16px"><h3>За этот день пока нет записей</h3><p>Можно оставить его пустым или добавить воспоминание сейчас.</p></div>`;
    out+=`<div class="two-col"><div class="stack"><section class="panel"><div class="card-title"><div><h2>Мой план</h2><p>Какие действия я намечала на этот день.</p></div></div><div class="daily-fields">${archiveField('Самое важное действие','main','Что было главным?',d)}${archiveField('Если сил мало, достаточно…','fallback','Самый маленький шаг',d)}${archiveField('Если останутся силы','extra','Необязательное',d)}</div>${dailySaveStatus()}</section>`;
    if(selected.length)out+=`<section class="panel"><h3>Выбранные на тот день шаги</h3><p class="small muted" style="margin:8px 0">Показываются названия. Статусы задач могут уже измениться.</p>${selected.map(t=>`<div class="list-card"><div class="list-card-content"><span class="task-title">${h(t.title)}</span></div></div>`).join('')}</section>`;
    out+=`</div><div class="stack"><section class="panel peach"><h3>Как я себя чувствовала?</h3><p class="small muted" style="margin:7px 0 12px">Сколько было сил в тот день?</p><div class="segment">${[['мало','Мало'],['обычно','Обычно'],['много','Много']].map(([e,label])=>`<button data-action="archive-energy" data-id="${e}" class="${(d.energy||'обычно')===e?'active':''}">${label}</button>`).join('')}</div><div style="margin-top:16px">${archiveField('Что было для меня хорошим?','care','Прогулка, отдых, разговор…',d)}</div>${dailySaveStatus()}</section>`;
    out+=`<section class="panel"><h3>В конце дня</h3><p class="small muted" style="margin:7px 0 12px">Что получилось? Что было важным?</p>${archiveField('Мои наблюдения','note','Можно оставить пустым',d)}${dailySaveStatus()}</section></div></div>`;
    return out;
  }
  const taskCompleted = t => t.status==='Готово';
  const byGoal = id => data.goals.find(g=>Number(g.id)===Number(id));
  function markChange(redraw=true){
    localChanges++; dirty=true;
    if(!HAS_CLOUD){try{localStorage.setItem(LOCAL_KEY,JSON.stringify(data));syncState='Сохранено на этом устройстве'}catch{syncState='Ошибка сохранения: скачайте копию'}}
    else if(mode==='ready'&&!conflict){syncState='Сохраняю…';clearTimeout(saveTimer);saveTimer=setTimeout(saveCloud,650)}
    if(redraw)render();else renderSyncLabel();
  }
  function renderSyncLabel(){document.querySelectorAll('[data-sync-label]').forEach(el=>el.textContent=syncState);document.querySelectorAll('[data-sync-dot]').forEach(el=>el.className='sync-dot '+statusClass())}
  function notify(msg){let n=$('toast');if(!n){n=document.createElement('div');n.id='toast';n.className='toast';document.body.append(n)}n.textContent=msg;clearTimeout(toastTimer);toastTimer=setTimeout(()=>n.remove(),4200)}
  function saveFile(filename,contents,type){const blob=new Blob([contents],{type});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=filename;document.body.append(a);a.click();setTimeout(()=>{URL.revokeObjectURL(a.href);a.remove()},1000)}
  function exportData(){saveFile('moya-strategiya-backup-'+today()+'.json',JSON.stringify(data,null,2),'application/json;charset=utf-8');notify('Резервная копия скачана')}
  const validISO = x => /^\d{4}-\d{2}-\d{2}$/.test(String(x||'')) && !Number.isNaN(Date.parse(x+'T12:00:00'));
  const guid = prefix => prefix+'-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,7);
  // Рекомендации всегда строятся из актуальных задач. Прежние заранее расписанные
  // подсказки остаются дополнительными, а отметки реальных задач едины по всему сайту.
  const activeTask = t => t && !['Готово','Пауза','Жду ответа','Входящие'].includes(t.status);
  const isEnglishTask = t => t && (Number(t.goalId)===3 || /IELTS|English/i.test(t.title||''));
  function taskMinutes(t){const b=Number(t.blocks);return Number.isFinite(b)&&b>0?Math.min(600,b*30):30}
  function suggestedFor(date){
    const d=data.daily[date]||{},energy=d.energy||'обычно';
    const limit=energy==='мало'?1:energy==='много'?3:2;
    const budget=energy==='мало'?35:energy==='много'?170:100;
    let left=budget;
    const tasks=data.tasks.filter(t=>activeTask(t)&&t.due&&t.due<=date)
      .sort((a,b)=>a.due.localeCompare(b.due)||Number(b.goalId===2)-Number(a.goalId===2));
    const soon=data.tasks.filter(t=>activeTask(t)&&(!t.due||t.due>date))
      .sort((a,b)=>(a.due||'9999').localeCompare(b.due||'9999'));
    const chosen=[];
    for(const t of [...tasks,...soon]){
      if(chosen.length>=limit)break;
      if(energy==='мало'&&t.energy==='Высокая')continue;
      const duration=taskMinutes(t);
      if(chosen.length&&duration>left)continue;
      chosen.push({id:'task-'+t.id,kind:'task',taskId:t.id,text:t.nextStep||t.title,minutes:duration,optional:true,explain:t.due&&t.due<date?'Ранее запланированный срок':t.due===date?'Срок сегодня':isEnglishTask(t)?'Занятие английским':'Ближайший шаг из твоего плана'});
      left-=duration;
    }
    const seeded=Array.isArray(data.plannedDays?.[date])?data.plannedDays[date]:[];
    // Не дублируем заранее подготовленный шаг, если уже есть актуальная задача.
    const extras=seeded.filter(x=>!chosen.some(y=>y.text.toLowerCase().includes(String(x.text||'').toLowerCase().slice(0,25))));
    if(chosen.length) return [...chosen,...extras.slice(0,energy==='мало'?0:1)];
    if(extras.length) return extras.slice(0,1);
    return [{id:'review-'+date,kind:'review',text:'Выбрать один посильный следующий шаг или спокойно отдохнуть',minutes:10,optional:true}];
  }
  function renderPlannedToday(){
    const k=today(),d=day(),items=suggestedFor(k);
    let out=`<section class="panel" style="margin-bottom:17px"><div class="card-title"><div><h2>Предложение на сегодня</h2><p>Из твоих актуальных задач и доступных сил. Это можно менять.</p></div><span class="pill lilac">${d.energy||'обычно'}</span></div>`;
    const oldCompleted=d.completedSuggestions||[];
    for(const x of items){
      const real=x.taskId?data.tasks.find(t=>t.id===x.taskId):null;
      const checked=real?taskCompleted(real):oldCompleted.includes(x.id);
      out+=`<div class="task-check"><input type="checkbox" data-action="${real?'check-task':'check-suggestion'}" data-id="${attr(real?.id||x.id)}" ${checked?'checked':''} aria-label="Отметить"><div style="flex:1"><div class="task-title ${checked?'done':''}">${h(real?.title||x.text)}</div>${real?.nextStep?`<div class="small muted" style="margin:5px 0">Начать с: ${h(real.nextStep)}</div>`:''}<div class="task-meta">${x.minutes?x.minutes+' мин · ':''}${h(x.explain||'Необязательный ориентир')}</div></div>${real?`<button class="button sm ghost" data-action="stuck-task" data-id="${attr(real.id)}">Я застряла</button>`:''}</div>`;
    }
    out+=`<div class="row-actions" style="margin-top:13px"><button class="button sm" data-action="capture-inbox">+ Быстро записать</button><button class="button sm" data-action="tab" data-id="english">Мой английский ↗</button></div><p class="sheet-callout">Сроки и подсказки можно переносить без «долгов по продуктивности». Уже выполненная задача отмечается во всех разделах.</p></section>`;
    return out;
  }
  function parseVoiceMoney(text){const m=String(text||'').match(/(?:^|\s)([0-9][0-9\s]*(?:[,.][0-9]{1,2})?)\s*(€|евро|eur|лари|gel|₾|рублей|рубля|руб|₽|rub)(?=\s|$|[,.!?])/i);
    if(!m)return null;return {amount:Number(m[1].replace(/\s+/g,'').replace(',','.')),currency:/лари|gel|₾/i.test(m[2])?'GEL':/руб|rub|₽/i.test(m[2])?'RUB':'EUR'};
  }
  function spokenDate(text){const v=String(text||'').toLowerCase(),now=dateLocal(today());if(/послезавтра/.test(v)){now.setDate(now.getDate()+2);return todayFromDate(now)}if(/завтра/.test(v)){now.setDate(now.getDate()+1);return todayFromDate(now)}
    const days=['воскресень','понедельник','вторник','сред','четверг','пятниц','суббот'];
    const ix=days.findIndex(prefix=>v.includes(prefix));if(ix<0)return null;
    let diff=(ix-now.getDay()+7)%7;if(diff===0)diff=7;now.setDate(now.getDate()+diff);return todayFromDate(now);
  }
  function todayFromDate(d){return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`}
  function updateCaptureFields(text){const form=$('capture-form');if(!form)return;const guess=parseVoiceMoney(text),date=spokenDate(text),amt=form.querySelector('[name="amount"]'),currency=form.querySelector('[name="currency"]'),when=form.querySelector('[name="date"]'),kind=$('capture-kind');if(date&&when)when.value=date;if(guess){if(amt&&!amt.value)amt.value=guess.amount;if(currency)currency.value=guess.currency;if(kind)kind.value='expense';}}
  function parsePatch(raw){let val=JSON.parse(raw);if(val?.type!=='next-chapter-patch'||val?.version!==1||!Array.isArray(val.changes)||val.changes.length>150)throw Error('Нужен пакет next-chapter-patch версии 1 (не больше 150 изменений).');
    for(const c of val.changes){if(!c||!['add_task','add_expense','update_task'].includes(c.op))throw Error('Неизвестная операция в пакете');
      if(c.op==='add_task' && (!String(c.title||'').trim() || String(c.title).length>500 || !data.goals.some(g=>Number(g.id)===Number(c.goalId))))throw Error('У задачи должны быть название и номер существующей цели');
      if(c.op==='add_expense' && (!(Number(c.amount)>0) || !['EUR','GEL','RUB','USD'].includes(c.currency) || !validISO(c.date)))throw Error('Для расхода нужны дата YYYY-MM-DD, положительная сумма и валюта');
      if(c.op==='update_task' && (!data.tasks.some(t=>t.id===c.id)|| !['Готово','Следующий шаг','В работе','Пауза'].includes(c.status)))throw Error('Нельзя обновить неизвестную задачу или состояние');
      if(c.due && !validISO(c.due))throw Error('Неверный срок задачи');
    }return val;
  }
  function applyPatch(v){for(const c of v.changes){
    if(c.op==='add_task'){if(data.tasks.some(t=>t.title===String(c.title).trim()&&t.due===(c.due||'')&&Number(t.goalId)===Number(c.goalId)))continue;data.tasks.push({id:guid('T'),goalId:Number(c.goalId),category:byGoal(c.goalId)?.category||'',title:String(c.title).trim(),due:c.due||'',status:'Следующий шаг',notes:String(c.notes||'').slice(0,3000),source:'Обсуждение в ChatGPT'});}
    if(c.op==='add_expense')data.transactions.push({id:guid('X'),date:c.date,amount:Number(c.amount),currency:c.currency,category:String(c.category||'Другое').slice(0,120),note:String(c.note||'').slice(0,300),source:'Пакет из ChatGPT'});
    if(c.op==='update_task'){let t=data.tasks.find(t=>t.id===c.id);t.status=c.status;if(c.status==='Готово'&&!t.completedAt)t.completedAt=today();if(c.status!=='Готово')t.completedAt='';if(c.due)t.due=c.due;}
  }}

  function scheduleAll(){render()}
  function contentHeader(heading,sub,eyebrow='ЛИЧНЫЙ СТРАТЕГИЧЕСКИЙ КАБИНЕТ'){
    return `<div class="header"><div><div class="eyebrow" style="margin-bottom:11px">${h(eyebrow)}</div><h1>${heading}</h1><p class="muted" style="margin-top:10px">${sub}</p></div><div class="header-actions"><span class="pill gray">2026–2027</span><button class="button sm" data-action="tab" data-id="settings" aria-label="Настройки">⚙ Настройки</button></div></div>`;
  }
  function shell(){let s=`<div class="shell"><aside class="sidebar"><div class="brand"><div class="logo">∿</div><div><div class="brand-title">моя следующая<br>глава</div><div class="brand-sub">личная стратегия</div></div></div><div class="nav">`;
    for(const p of sections)s+=`<button type="button" class="nav-button ${view===p.id?'active':''}" data-action="tab" data-id="${p.id}"><span class="nav-icon">${p.icon}</span>${p.title}</button>`;
    s+=`<button type="button" class="nav-button ${view==='settings'?'active':''}" data-action="tab" data-id="settings"><span class="nav-icon">⚙</span>Настройки</button></div><div class="side-footer"><div class="small"><span data-sync-dot class="sync-dot ${statusClass()}"></span><span data-sync-label>${h(syncState)}</span></div><div class="tiny muted">Двигаться в своём темпе.<br>План можно менять.</div></div></aside><main class="main">`;
    s+=({today:renderToday,weeks:renderWeeks,strategy:renderStrategy,tasks:renderTasks,finances:renderFinances,review:renderReview,projects:renderProjects,english:renderEnglish,settings:renderSettings})[view]();
    s+=`<p class="footer-note">Здесь нет серии без пропусков. Одна сложная неделя не отменяет твою стратегию.</p></main><nav class="mobile-nav">`;
    for(const p of [...sections,{id:'settings',icon:'⚙',title:'Настройки'}])s+=`<button data-action="tab" data-id="${p.id}" class="${view===p.id?'active':''}"><span>${p.icon}</span>${p.title}</button>`;
    s+='</nav></div>';return s;
  }
  function importPrompt(){return `<div class="empty big"><div class="empty-icon">✧</div><h3>Твоя стратегия готова к переносу</h3><p>Загрузи файл <b>moia_strategia_2026-2027.json</b> из папки «private-import». Девять долгосрочных ориентиров, годовые результаты, 52 недели и 28 шагов появятся здесь автоматически.</p><div class="row-actions"><button class="button primary" data-action="trigger-import">Импортировать стратегию</button><button class="button" data-action="tab" data-id="settings">Как сохраняются данные</button></div></div>`}
  function syncWarning(){return conflict?`<div class="notice" style="margin-bottom:14px"><b>Конфликт изменений между устройствами.</b> Данные на сервере уже обновились. Скачай локальную копию, затем загрузи новую облачную версию. <div class="row-actions" style="margin-top:8px"><button class="button sm" data-action="export">Скачать мою версию</button><button class="button sm" data-action="reload-cloud">Загрузить облачную</button></div></div>`:''}
  function renderToday(){if(!validISO(selectedDailyDate)||selectedDailyDate>today())selectedDailyDate=today();if(selectedDailyDate!==today())return renderDailyArchive();let w=week(),d=day(),tasklist=(d.taskIds||[]).map(id=>data.tasks.find(t=>t.id===id)).filter(Boolean),options=data.tasks.filter(t=>!taskCompleted(t)&&!(d.taskIds||[]).includes(t.id));let finished=data.tasks.filter(taskCompleted).length;
    let out=contentHeader('Сегодня',`${nice(today())}. Один содержательный шаг тоже считается движением.`, 'МОЯ СЛЕДУЮЩАЯ ГЛАВА')+syncWarning();
    if(!data.goals.length)return out+importPrompt();
    out+=dailyNavigation();
    out+=`<section class="panel hero" style="margin-bottom:17px"><div class="eyebrow">ФОКУС НЕДЕЛИ · ${w?niceShort(w.start)+' – '+niceShort(w.end):'нет недели'}</div><h2>${h(w?.focus||'Выбери, что должно измениться на этой неделе')}</h2><p class="muted">${h(w?.second?'Дополнительно: '+w.second:'Лучше один настоящий результат, чем десять пунктов в списке.')}</p><div style="margin-top:17px">${button('tab','Открыть неделю  ↗','sm')}</div></section>`;
    out+=renderPlannedToday();
    out+=`<div class="two-col"><div class="stack"><section class="panel"><div class="card-title"><div><h2>Мой план</h2><p>Не обязательно заполнять все поля.</p></div><button class="button sm" data-action="quick-capture">🎙 Сказать / написать</button></div><div class="field"><label class="field-label">Самое важное действие</label><textarea class="textarea compact" data-bind="daily:main" placeholder="Что сегодня реально сдвинет дело?">${h(d.main)}</textarea></div><div class="field" style="margin-top:14px"><label class="field-label">Если сил мало, достаточно...</label><textarea class="textarea compact" data-bind="daily:fallback" placeholder="Самый маленький полезный шаг">${h(d.fallback)}</textarea></div><div class="field" style="margin-top:14px"><label class="field-label">Если останутся силы</label><textarea class="textarea compact" data-bind="daily:extra" placeholder="Необязательное действие">${h(d.extra)}</textarea></div>${dailySaveStatus()}</section>`;
    out+=`<section class="panel"><div class="card-title"><div><h3>Шаги, которые я выбрала на сегодня</h3><p>Список связан с твоими девятью результатами.</p></div></div>`;
    if(!tasklist.length)out+=`<p class="muted small" style="margin-bottom:12px">Здесь пока пусто. Добавь одну задачу из плана.</p>`;
    for(const t of tasklist)out+=`<div class="task-check"><input aria-label="Отметить готовым" type="checkbox" data-action="check-task" data-id="${attr(t.id)}" ${taskCompleted(t)?'checked':''}><div style="flex:1"><div class="task-title ${taskCompleted(t)?'done':''}">${h(t.title)}</div><div class="task-meta">${h(t.category)}${t.due?' · до '+niceShort(t.due):''}</div></div><button class="button ghost sm" data-action="remove-today-task" data-id="${attr(t.id)}" title="Убрать из сегодняшнего списка">×</button></div>`;
    if(options.length)out+=`<div class="field" style="margin-top:15px"><label class="field-label">Добавить из плана</label><select class="select" data-bind="add-today"><option value="">Выбрать шаг…</option>${options.map(t=>`<option value="${attr(t.id)}">${h(first(t.title,85))}</option>`).join('')}</select></div>`;
    else out+=`<div class="row-actions" style="margin-top:12px">${button('new-task','Добавить новую задачу','sm')}</div>`;
    out+='</section></div>';
    out+=`<div class="stack"><section class="panel peach"><div class="card-title"><div><h3>Как я сегодня?</h3><p>Силы могут меняться. План учитывает это.</p></div></div><div class="segment">${[['мало','Мало'],['обычно','Обычно'],['много','Много']].map(([k,v])=>`<button data-action="energy" data-id="${k}" class="${d.energy===k?'active':''}">${v}</button>`).join('')}</div>${d.energy==='мало'?`<p class="small" style="margin-top:13px;color:#7e5849">Сегодня достаточно одного небольшого действия. Можно убрать всё необязательное.</p>`:''}<div class="field" style="margin-top:15px"><label class="field-label">Что сегодня будет для меня хорошим?</label><textarea class="textarea compact" data-bind="daily:care" placeholder="Прогулка, еда, отдых, разговор...">${h(d.care)}</textarea></div>${dailySaveStatus()}</section>`;
    out+=`<section class="panel"><h3>В конце дня, если хочется</h3><p class="muted small" style="margin:8px 0 13px">Что получилось? Что стоит перенести? Без отчёта о продуктивности.</p><textarea class="textarea" data-bind="daily:note" placeholder="Можно оставить пустым">${h(d.note)}</textarea>${dailySaveStatus()}</section>`;
    out+=`<section class="panel"><div class="eyebrow">РЕАЛЬНОЕ ДВИЖЕНИЕ</div><div class="kpi-value" style="margin-top:6px">${finished} <span class="small muted">из ${data.tasks.length} шагов</span></div><p class="muted small">Отмеченные завершённые действия. Это не процент успешности твоей жизни.</p><div style="margin-top:14px"><button class="button sm" data-action="tab" data-id="tasks">Все шаги ↗</button></div></section></div></div>`;
    return out;
  }
  function weekField(w,k,label,placeholder='',type='textarea'){return `<div class="field"><label class="field-label">${label}</label>${type==='number'?`<input class="input" type="number" min="0" max="120" data-bind="week:${k}" value="${attr(w[k]??'')}" placeholder="Часы">`:`<textarea class="textarea compact" data-bind="week:${k}" placeholder="${attr(placeholder)}">${h(w[k]??'')}</textarea>`}</div>`}
  function renderWeeks(){let w=week(),i=getWeekIndex();let out=contentHeader('Моя неделя','Текущие результаты, ограничения и короткая ретроспектива. Сюда можно вернуться после любой паузы.');if(!w)return out+importPrompt();
    out+=`<div class="panel"><div class="period-nav"><div><div class="eyebrow">НЕДЕЛЯ ${i+1} ИЗ ${data.weeks.length}</div><h2 style="margin-top:5px">${niceShort(w.start)} — ${niceShort(w.end)}</h2></div><div class="date-nav"><button class="button sm" data-action="prev-week" ${i===0?'disabled':''}>← Раньше</button><button class="button sm" data-action="current-week">Текущая</button><button class="button sm" data-action="next-week" ${i===data.weeks.length-1?'disabled':''}>Позже →</button></div></div><div class="grid-fields">${weekField(w,'focus','Главный результат недели','Что должно реально измениться?')}${weekField(w,'second','Второй результат, если есть силы','Не обязательно')}</div><div class="grid-fields" style="margin-top:15px">${weekField(w,'critical','Обязательства и дедлайны','Что нельзя пропустить?')}${weekField(w,'rest','Время для себя','Когда я отдыхаю?')}</div><div class="field" style="margin-top:15px">${weekField(w,'hours','Сколько часов реально есть для стратегического развития?','', 'number')}</div><div class="separator" style="margin:22px 0"></div><h3 style="margin-bottom:13px">В конце недели</h3><div class="grid-fields">${weekField(w,'actual','Что реально изменилось?','Результаты, а не количество рабочих часов')}${weekField(w,'learning','Что я поняла и что нужно перенести?','Какие решения скорректировать?')}</div><p class="sheet-callout">Записи сохраняются после выхода из поля. Не нужно заполнять следующие 52 недели заранее.</p></div>`;
    out+=`<div class="two-col" style="margin-top:16px"><section class="panel"><h3>Откуда берётся план недели?</h3><p class="muted" style="margin-top:9px">Из результатов на квартал, текущей финансовой ситуации и уже существующих обязательств. План можно менять без чувства, что ты нарушила стратегию.</p><div class="row-actions" style="margin-top:16px"><button class="button sm" data-action="tab" data-id="strategy">Посмотреть стратегию</button><button class="button sm" data-action="tab" data-id="tasks">Открыть шаги</button></div></section><section class="panel tinted"><h3>Когда пора пересмотреть неделю?</h3><p style="margin-top:8px">Если изменилась нагрузка, стало меньше сил или появился неожиданный важный вопрос. Можно сократить фокус до одного действия и спокойно продолжить.</p></section></div>`;
    return out;
  }

  function renderStrategy(){let out=contentHeader('Мой курс','Девять результатов на 3–5 лет, годовые ориентиры и два условия, без которых стратегия теряет смысл.');if(!data.goals.length)return out+importPrompt();
    out+=`<div class="panel tinted" style="margin-bottom:19px"><div class="eyebrow">ГЛАВНЫЙ ВОПРОС</div><h2 style="margin:10px 0">Какую профессиональную и личную жизнь я хочу построить в ближайшие 3–5 лет?</h2><p class="muted">Что нужно изменить за год, чтобы стать устойчивее и двигаться к ней?</p></div>`;
    const goalGroups=data.groups.length?data.groups:[{name:'Мои цели',ids:data.goals.map(g=>Number(g.id)),description:'Долгосрочные ориентиры и результаты на год.'}];
    for(const group of goalGroups){let gs=data.goals.filter(g=>group.ids.includes(Number(g.id)));if(!gs.length)continue;
      out+=`<section style="margin:28px 0 12px"><h2>${group.name}</h2><p class="muted small" style="margin-top:5px">${group.description}</p></section><div class="three-col">`;
      for(const g of gs)out+=`<article class="panel flat goal-card"><div class="row-actions"><span class="pill gray">${String(g.id).padStart(2,'0')}</span>${pill(g.status)}</div><h3>${h(g.vision)}</h3><p class="caption"><span class="eyebrow">К октябрю 2027</span><br>${h(first(g.annual,205))}</p><div class="goal-actions"><button class="button sm" data-action="goal" data-id="${g.id}">Открыть цель ↗</button></div></article>`;
      out+='</div>';
    }
    const currentQuarter='Q'+(today()<'2027-01-16'?1:today()<'2027-04-16'?2:today()<'2027-07-16'?3:4);
    const qq=data.quarters.filter(q=>q.quarter===currentQuarter);
    out+=`<section class="panel" style="margin-top:24px"><div class="card-title"><div><h2>Результаты текущего квартала</h2><p>По направлениям. Это рабочие гипотезы, их можно корректировать.</p></div><span class="pill blue">${currentQuarter}</span></div>`;
    if(!qq.length)out+='<p class="muted">В этом квартале пока нет результатов.</p>';
    for(const q of qq)out+=`<div class="quarter-card"><div class="quarter-label">${h(q.category)}</div><div><p class="strong">${h(q.outcome)}</p><p class="small muted" style="margin:7px 0">Проверка: ${h(q.evidence)}</p><div class="grid-fields" style="margin-top:10px"><div class="field"><label class="field-label">Состояние</label><select class="select" data-bind="quarter:${attr(q.id)}:status">${['План','В работе','Готово','Пересмотреть','Пауза'].map(s=>`<option ${q.status===s?'selected':''}>${s}</option>`).join('')}</select></div><div class="field"><label class="field-label">Что изменилось / что мешает</label><input class="input" data-bind="quarter:${attr(q.id)}:notes" value="${attr(q.notes)}" placeholder="Необязательно"></div></div></div></div>`;
    out+='</section>';return out;
  }
  function renderTasks(){let all=data.tasks.filter(t=>(taskFilter==='Все'||t.status===taskFilter)&&(goalFilter==='Все'||Number(t.goalId)===Number(goalFilter))&&(projectFilter==='Все'||(projectFilter==='_english'?isEnglishTask(t):t.projectId===projectFilter))),byStatus=data.tasks.filter(taskCompleted).length;
    let out=contentHeader('Мои шаги','Здесь конкретные действия. Их можно менять, откладывать, удалять и добавлять по мере появления новой информации.');
    out+=`<div class="panel" style="margin-bottom:16px"><div class="card-title"><div><h2>${byStatus} <span class="muted small">из ${data.tasks.length} выполнено</span></h2><p>Это ориентир для обзора, а не оценка твоей продуктивности.</p></div><div class="row-actions"><button class="button primary" data-action="new-task">+ Новый шаг</button><button class="button" data-action="capture-inbox">Записать мысль</button></div></div><div class="filter-row">${['Все','Входящие','Следующий шаг','В работе','Жду ответа','Готово','Пауза'].map(s=>`<button class="button sm ${taskFilter===s?'active':''}" data-action="task-filter" data-id="${attr(s)}">${s}</button>`).join('')}</div><div class="field"><label class="field-label">Показать шаги по цели</label><select class="select" data-bind="task-filter-goal"><option value="Все">Все девять результатов</option>${data.goals.map(g=>`<option value="${g.id}" ${Number(goalFilter)===Number(g.id)&&goalFilter!=='Все'?'selected':''}>${h(g.id)}. ${h(first(g.vision,72))}</option>`).join('')}</select></div><div class="field" style="margin-top:12px"><label class="field-label">Проект</label><select class="select" data-bind="task-filter-project"><option value="Все">Все проекты</option><option value="_english" ${projectFilter==='_english'?'selected':''}>English / IELTS Academic</option>${data.projects.map(p=>`<option value="${attr(p.id)}" ${projectFilter===p.id?'selected':''}>${h(p.title)}</option>`).join('')}</select></div></div>`;
    out+='<div class="panel">';if(!all.length)out+='<div class="empty"><h3>Пока нет шагов по этому фильтру</h3><p>Можно переключить фильтр или добавить новый шаг.</p></div>';
    for(const t of all){out+=`<div class="task-check"><input type="checkbox" data-action="check-task" data-id="${attr(t.id)}" aria-label="Шаг выполнен" ${taskCompleted(t)?'checked':''}><div style="flex:1"><div class="task-title ${taskCompleted(t)?'done':''}">${h(t.title)}</div><div class="task-meta">${t.goalId?'Цель '+h(t.goalId):'Без привязки'} · ${h(t.category)}${t.due?' · '+niceShort(t.due):''} · ${h(t.energy||'')}</div>${t.doneWhen?`<div class="small muted" style="margin-top:5px">Готово, когда: ${h(t.doneWhen)}</div>`:''}</div><div class="row-actions"><button class="button sm ghost" data-action="stuck-task" data-id="${attr(t.id)}">Я застряла</button><button class="button sm ghost" data-action="edit-task" data-id="${attr(t.id)}">Править</button></div></div>`}
    out+='</div>';return out;
  }
  function calcMoney(m){let fields=[m.mandatory,m.variable,m.debt];if(fields.every(x=>x==null||x===''))return [null,null];let total=fields.reduce((a,x)=>a+Number(x||0),0);return [total,m.confirmed==null?null:Number(m.confirmed)-total]}
  function renderFinances(){let out=contentHeader('Финансовая опора','Подтверждённые поступления отдельно от вероятных. Прогноз помогает выбирать, а не заменяет бухгалтерию.');if(!data.finances.length)return out+importPrompt();
    const current=data.finances.find(m=>m.month===today().slice(0,7))||data.finances[0];const [need,gap]=calcMoney(current);
    out+=`<div class="three-col" style="margin-bottom:17px"><div class="panel"><div class="kpi-label">Подтверждено · ${monthTitle(current.month)}</div><div class="kpi-value">${euro(current.confirmed)}</div></div><div class="panel"><div class="kpi-label">Планируемые расходы</div><div class="kpi-value">${euro(need)}</div></div><div class="panel"><div class="kpi-label">Остаток / дефицит</div><div class="kpi-value" style="color:${gap!=null&&gap<0?'#a65f4d':'#476f60'}">${euro(gap)}</div></div></div>`;
    out+=`<div class="panel"><div class="card-title"><div><h2>Прогноз по месяцам</h2><p>Все суммы в евро. Пустое поле означает «пока неизвестно».</p></div></div><div class="table-scroll"><table class="money-table"><thead><tr>${['Месяц','Подтверждено','Вероятно','Обязательные','Переменные','Долги','Всего нужно','Остаток','Резерв'].map(x=>`<th>${x}</th>`).join('')}</tr></thead><tbody>`;
    const names={confirmed:'Подтверждено',probable:'Вероятно',mandatory:'Обязательные',variable:'Переменные',debt:'Долги',reserve:'Резерв'};
    for(const m of data.finances){let [total,left]=calcMoney(m);out+=`<tr><td class="date-cell">${monthTitle(m.month)}</td>`;
      for(const k of ['confirmed','probable','mandatory','variable','debt'])out+=`<td><input type="number" min="0" step="0.01" data-bind="money:${attr(m.id)}:${k}" aria-label="${names[k]} ${monthTitle(m.month)}" placeholder="—" value="${m[k]??''}"></td>`;
      out+=`<td class="strong">${euro(total)}</td><td class="${left==null?'':left<0?'negative':'positive'}">${euro(left)}</td><td><input type="number" min="0" step="0.01" data-bind="money:${attr(m.id)}:reserve" aria-label="Резерв ${monthTitle(m.month)}" placeholder="—" value="${m.reserve??''}"></td></tr>`;
    }out+='</tbody></table></div><p class="sheet-callout">Формула: остаток = подтверждённые поступления − обязательные расходы − переменные расходы − платежи по долгам. Вероятные поступления в остаток не входят.</p></div>';
    const trans=data.transactions.slice().sort((a,b)=>b.date.localeCompare(a.date));
    out+=`<div class="panel" style="margin-top:16px"><div class="card-title"><div><h2>Записанные расходы</h2><p>Это фактические операции. Они отдельно от плановых сумм выше, чтобы не возникало двойного вычитания.</p></div><button class="button sm" data-action="quick-capture">🎙 Добавить расход</button></div>`;
    if(!trans.length)out+='<p class="muted">Пока операций нет. Можно добавить расход голосом или пакетом из чата.</p>';
    for(const t of trans.slice(0,30))out+=`<div class="task-check"><div style="flex:1"><div class="strong">${h(t.date)} · ${h(t.amount)} ${h(t.currency)}</div><div class="task-meta">${h(t.category||'Другое')} · ${h(t.note||'')}</div></div><button class="button sm ghost" data-action="delete-transaction" data-id="${attr(t.id)}">Удалить</button></div>`;
    out+=`<p class="sheet-callout">Разные валюты не суммируются без курса. Для анализа загрузи мне актуальную копию или сообщи новые операции, чтобы я сформировала пакет изменений.</p></div>`;
    out+=`<div class="panel peach" style="margin-top:16px"><h3>Правило безопасности</h3><p style="margin-top:7px">Если несколько месяцев подряд прогнозируется дефицит по подтверждённым деньгам, пора отдельно пересмотреть финансовые решения. Личный стратегический трекер не должен скрывать кассовые разрывы за оптимистичными ожиданиями.</p></div>`;return out;
  }
  function renderReview(){
    const key=selectedReviewMonth;
    const r=data.reviews[key]||{};
    const completed=data.tasks.filter(t=>t.status==='Готово' && t.completedAt?.slice(0,7)===key);
    const spent=data.transactions.filter(t=>t.date?.slice(0,7)===key);
    const monthWeeks=data.weeks.filter(w=>w.start?.slice(0,7)===key || w.end?.slice(0,7)===key);
    const allMonths=[...new Set([today().slice(0,7),key,...Object.keys(data.reviews),...data.weeks.map(w=>w.start?.slice(0,7))])].filter(x=>/^\d{4}-\d{2}$/.test(x)).sort().reverse();
    let out=contentHeader('Ретроспектива месяца','Вспомнить события, заметить цену результатов и решить, что менять дальше.');
    out+=`<div class="panel" style="margin-bottom:16px"><div class="card-title"><div><div class="eyebrow">МЕСЯЧНЫЙ ОБЗОР · ORID</div><h2 style="margin-top:7px">${monthTitle(key)}</h2></div><span class="pill lilac">45–60 минут</span></div><div class="field"><label class="field-label">Какой месяц посмотреть?</label><select class="select" data-bind="review-month">${allMonths.map(m=>`<option value="${m}" ${m===key?'selected':''}>${monthTitle(m)}</option>`).join('')}</select></div></div>`;
    out+=`<section class="panel tinted" style="margin-bottom:16px"><h3>Что приложение уже знает</h3><p class="small muted" style="margin:6px 0 12px">Ниже только те результаты, у которых сохранилась дата завершения. Старые задачи без даты здесь не учитываются.</p><div class="three-col"><div><div class="kpi-value">${completed.length}</div><div class="small muted">задач завершено с датой</div></div><div><div class="kpi-value">${monthWeeks.filter(w=>w.actual).length}</div><div class="small muted">недель с результатами</div></div><div><div class="kpi-value">${spent.length}</div><div class="small muted">записей о расходах</div></div></div>`;
    if(completed.length)out+=`<div style="margin-top:12px"><strong>Завершено:</strong> ${h(completed.slice(0,7).map(t=>t.title).join(' · '))}</div>`;
    out+='</section>';
    const fields=[
      ['change','1. Objective · Что произошло?','Какие результаты, события и изменения были значимыми? Что выпало из цифрового журнала?'],
      ['feelings','2. Reflective · Как я это прожила?','Когда было интересно, тревожно, трудно или хорошо? Что чувствовала?'],
      ['cost','Сколько это стоило сил?','Что требовало неоплачиваемого труда? Где я работала за пределами своих ресурсов?'],
      ['learning','3. Interpretive · Что я поняла?','Какие способы работы помогали? Какие гипотезы не подтвердились? От кого и от чего я зависела?'],
      ['life','Что происходило с моей собственной жизнью?','Отдых, здоровье, отношения, удовольствие. Что стоило защитить?'],
      ['decision','4. Decisional · Что меняю в следующем месяце?','Что сохраняю, сокращаю, делегирую, останавливаю? Не больше трёх решений.'],
      ['checkDate','Когда я вернусь к этим решениям?','На что посмотрю через месяц?']
    ];
    out+='<div class="panel"><div class="form-stack">';
    for(const [id,title,placeholder] of fields)out+=`<div class="field"><label class="field-label">${title}</label><textarea class="textarea" data-bind="review:${id}" placeholder="${h(placeholder)}">${h(r[id]||'')}</textarea></div>`;
    out+=`</div><p class="sheet-callout">Запись остаётся привязана к этому месяцу и не заменяет предыдущие ретроспективы. Приложение не создаёт из твоих решений задачи автоматически: сначала ты сама подтверждаешь выбор.</p></div>`;
    return out;
  }
  function renderProjects(){
    let out=contentHeader('Проекты','Здесь видны законченные результаты между долгосрочной целью и повседневными шагами.');
    out+=`<section class="panel" style="margin-bottom:16px"><div class="card-title"><div><h2>Мои проекты</h2><p>Не обязательно запускать всё одновременно. Это рабочие пространства, а не дополнительные обязанности.</p></div><button class="button primary" data-action="new-project">+ Проект</button></div></section>`;
    const virtual={id:'_english',title:'English / IELTS Academic 7.5',description:'Вводный курс, диагностика, развитие языка и подготовка к экзамену.',goalId:3,status:'В работе'};
    const projects=[virtual,...data.projects.filter(p=>p.id!=='_english')];
    out+='<div class="two-col">';
    for(const p of projects){const tasks=data.tasks.filter(t=>p.id==='_english'?isEnglishTask(t):t.projectId===p.id);
      const active=tasks.filter(t=>!taskCompleted(t));out+=`<section class="panel"><div class="card-title"><div><h3>${h(p.title)}</h3><p>${h(p.description||'')}</p></div>${pill(p.status)}</div><p class="small muted">${tasks.length} связанных шагов · ${active.length} открытых</p><div class="row-actions" style="margin-top:15px"><button class="button sm primary" data-action="${p.id==='_english'?'tab':'project-detail'}" data-id="${p.id==='_english'?'english':attr(p.id)}">Открыть ↗</button>${p.id!=='_english'?`<button class="button sm" data-action="edit-project" data-id="${attr(p.id)}">Изменить</button>`:''}</div></section>`;
    }out+='</div>';
    if(data.projects.length===0)out+='<div class="panel tinted" style="margin-top:16px"><h3>С чего начать?</h3><p style="margin-top:9px">Проект IELTS уже собран из существующих задач по английскому — ничего импортировать повторно не нужно. Остальные проекты ты можешь создавать, когда появится конкретный завершённый результат.</p></div>';
    return out;
  }
  function englishMeta(t){
    const notes=String(t.notes||'');
    const line=(label)=>{const m=notes.match(new RegExp('(?:^|\\n)'+label+':\\s*([^\\n]+)','i'));return m?m[1].trim():''};
    const url=notes.match(/https?:\/\/[^\s<>"']+/i)?.[0]||'';
    return {track:line('ЛИНИЯ')||'ENG / IELTS',minutes:line('ЛИНИЯ')?((notes.match(/\b(\d{1,3})\s*мин/i)||[])[1]||''):'',why:line('ЗАЧЕМ'),material:url};
  }
  function renderEnglish(){
    const tasks=data.tasks.filter(isEnglishTask).slice().sort((a,b)=>(a.due||'9999').localeCompare(b.due||'9999'));
    const now=today(), todays=tasks.filter(t=>t.due===now&&!taskCompleted(t));
    const next=tasks.filter(t=>!taskCompleted(t)&&t.due&&t.due>=now).slice(0,8);
    const older=tasks.filter(t=>!taskCompleted(t)&&t.due&&t.due<now);
    const done=tasks.filter(taskCompleted);
    let out=contentHeader('English / IELTS Academic 7.5','Программа, задания и проверки без необходимости самой каждый день искать материалы.','МОЯ УЧЁБНАЯ ПРОГРАММА');
    out+=`<section class="panel hero" style="margin-bottom:17px"><div class="eyebrow">ЦЕЛЬ · IELTS ACADEMIC</div><h2>7.5 overall · ориентир октябрь 2027</h2><p class="muted">Линии обучения: развитие английского (ENG) и освоение экзамена (IELTS). Оценка по Speaking и Writing в ChatGPT учебная, не официальный балл экзаменатора.</p></section>`;
    out+=`<div class="three-col" style="margin-bottom:17px"><div class="panel"><div class="kpi-value">${tasks.length}</div><div class="kpi-label">заданий в программе</div></div><div class="panel"><div class="kpi-value">${done.length}</div><div class="kpi-label">отмечено выполненными</div></div><div class="panel"><div class="kpi-value">${older.length}</div><div class="kpi-label">раньше запланированы, пересмотри при желании</div></div></div>`;
    out+=`<section class="panel" style="margin-bottom:16px"><div class="card-title"><div><h2>Урок на сегодня</h2><p>Задание из твоего календаря. Сохраняем то, что уже было загружено.</p></div></div>`;
    if(!todays.length)out+=`<p class="muted">На сегодня нет незавершённого урока с этой датой. Можешь продолжить ближайший урок или выбрать отдых.</p>`;
    for(const t of todays)out+=englishTaskCard(t,true);
    out+='</section>';
    out+=`<section class="panel" style="margin-bottom:16px"><h2 style="margin-bottom:12px">Ближайшие уроки</h2>`;
    if(!next.length)out+='<p class="muted">Пока нет будущих занятий. Новые появятся после следующего учебного блока.</p>';
    for(const t of next)out+=englishTaskCard(t,false);
    out+='</section>';
    if(older.length)out+=`<section class="panel" style="margin-bottom:16px"><h3>Ранее запланированные уроки</h3><p class="muted small" style="margin:7px 0 12px">${older.length} уроков. Пропущенное не образует долг: выбери то, что ещё полезно, или перенеси срок.</p>${older.slice(0,5).map(t=>englishTaskCard(t,false)).join('')}</section>`;
    out+=`<section class="panel tinted"><h3>Где делать и проверять задания?</h3><p style="margin-top:8px">Открывай ссылку на официальный или учебный материал, выполняй задание и сверяй ответы по опубликованному ключу. Writing и Speaking отправляй в отдельный проект ChatGPT «IELTS Academic 7.5». После разбора отметь урок в этом приложении. Проверка ChatGPT не приравнивается к официальной оценке.</p><div class="row-actions" style="margin-top:14px"><button class="button sm" data-action="copy-ielts-prompt">Скопировать запрос для разбора в ChatGPT</button></div></section>`;
    return out;
  }
  function englishTaskCard(t,expanded){const m=englishMeta(t),taskId=attr(t.id);
    return `<div class="english-task"><div class="row-actions" style="justify-content:space-between;align-items:flex-start"><div><div class="eyebrow">${h(m.track)} · ${t.due?niceShort(t.due):'Без даты'}</div><h3 style="margin:6px 0">${h(t.title)}</h3></div><input type="checkbox" ${taskCompleted(t)?'checked':''} data-action="check-task" data-id="${taskId}" title="Отметить урок завершённым" aria-label="Урок завершён"></div>${m.why?`<p class="small muted">${h(m.why)}</p>`:''}<div class="row-actions" style="margin-top:10px">${m.material?`<a class="button sm" href="${attr(m.material)}" target="_blank" rel="noopener noreferrer">Открыть материал ↗</a>`:''}<button class="button sm" data-action="edit-task" data-id="${taskId}">Инструкция и результат</button><button class="button sm ghost" data-action="stuck-task" data-id="${taskId}">Сложно начать</button></div></div>`;
  }
  function renderSettings(){let out=contentHeader('Настройки и данные','Резервные копии, синхронизация и возможность забрать всё с собой.');
    out+=`<div class="panel"><h2>Где хранится моя стратегия?</h2><p class="muted" style="margin-top:10px">${HAS_CLOUD?'Облачная база Supabase, доступ только после входа. Данные хранятся отдельно для каждой учётной записи.':'Пока только браузер этого устройства. Автоматической синхронизации нет. Для настоящей синхронизации нужно настроить Supabase по инструкции из комплекта.'}</p><div class="row-actions" style="margin-top:17px"><span class="pill ${HAS_CLOUD?'':'warn'}"><span data-sync-dot class="sync-dot ${statusClass()}"></span><span data-sync-label>${h(syncState)}</span></span>${HAS_CLOUD?`<button class="button sm" data-action="reload-cloud">Проверить облако</button><button class="button sm" data-action="logout">Выйти</button>`:''}</div>${HAS_CLOUD&&session?`<p class="small muted" style="margin-top:10px">Аккаунт: ${h(session.user.email||'')}</p>`:''}</div>`;
    out+=`<div class="panel"><h2>Мои данные всегда со мной</h2><p class="muted" style="margin:8px 0 18px">Скачай резервную копию JSON. Она содержит личные цели, финансы, задачи и заметки. Храни её в защищённом месте.</p><div class="row-actions"><button class="button primary" data-action="export">↓ Скачать резервную копию</button><button class="button" data-action="trigger-import">↑ Импортировать стратегию / копию</button></div><p class="sheet-callout">Обычные обновления сайта НЕ требуют импорта. При восстановлении старого файла текущая версия заменится; перед ним приложение скачает резервную копию.</p></div>`;
    out+=`<div class="panel"><h2>Изменения из разговора с ChatGPT</h2><p class="muted" style="margin:9px 0">Вставь пакет изменений из чата. Ты увидишь предварительный просмотр и сама подтвердишь добавление задач и расходов. Он НЕ заменяет твою стратегию целиком.</p><button class="button primary" data-action="chat-import">Вставить изменения из ChatGPT</button></div>`;
    out+=`<div class="panel tinted"><h3>Если я пропустила неделю</h3><p style="margin-top:8px">Можно вернуться сразу к сегодняшнему дню. Нет необходимости заполнять прошлые дни и закрывать старые задачи, чтобы снова начать двигаться.</p><div class="row-actions" style="margin-top:14px"><button class="button sm" data-action="go-current-week">Вернуться к текущей неделе</button></div></div>`;
    if(!HAS_CLOUD)out+=`<div class="notice" style="margin-top:16px">Для приватного облачного режима настрой авторизацию и политики доступа по файлу README. Не публикуй JSON со своими личными данными вместе с файлами сайта.</div>`;
    return out;
  }
  function renderModal(){if(!modal)return '';
    if(modal.type==='goal'){
      const g=byGoal(modal.id);if(!g)return '';
      return `<div class="modal-overlay" data-action="close-overlay"><section class="modal" role="dialog" aria-modal="true" aria-label="Редактирование цели"><div class="modal-head"><div><span class="pill gray">Цель ${h(g.id)}</span><h2 style="margin-top:8px">${h(g.vision)}</h2></div><button class="modal-close" data-action="close-modal" aria-label="Закрыть">×</button></div><div class="form-stack"><div class="field"><label class="field-label">Желаемый результат на 3–5 лет</label><textarea class="textarea" data-bind="goal:${g.id}:vision">${h(g.vision)}</textarea></div><div class="field"><label class="field-label">Результат к октябрю 2027</label><textarea class="textarea" data-bind="goal:${g.id}:annual">${h(g.annual)}</textarea></div><div class="field"><label class="field-label">Промежуточный результат к январю 2027</label><textarea class="textarea" data-bind="goal:${g.id}:january">${h(g.january)}</textarea></div><div class="field"><label class="field-label">Какие свидетельства покажут, что я продвигаюсь?</label><textarea class="textarea compact" data-bind="goal:${g.id}:evidence">${h(g.evidence)}</textarea></div><div class="grid-fields"><div class="field"><label class="field-label">Состояние</label><select class="select" data-bind="goal:${g.id}:status">${['Не начато','В работе','Готово','Пауза','Пересмотреть'].map(s=>`<option ${s===g.status?'selected':''}>${s}</option>`).join('')}</select></div><div class="field"><label class="field-label">Категория</label><input class="input" data-bind="goal:${g.id}:category" value="${attr(g.category)}"></div></div><div class="field"><label class="field-label">Что изменилось / важные мысли</label><textarea class="textarea" data-bind="goal:${g.id}:notes" placeholder="Место для свидетельств прогресса">${h(g.notes)}</textarea></div><div class="row-actions"><button class="button primary" data-action="close-modal">Закрыть и сохранить</button><button class="button" data-action="tab" data-id="tasks">Посмотреть действия по цели</button></div></div></section></div>`;
    }
    if(modal.type==='task'){
      const t=modal.id?data.tasks.find(x=>x.id===modal.id):null;
      return `<div class="modal-overlay" data-action="close-overlay"><section class="modal" role="dialog" aria-modal="true" aria-label="Задача"><div class="modal-head"><div><div class="eyebrow">${t?'РЕДАКТИРОВАНИЕ':'НОВЫЙ ШАГ'}</div><h2 style="margin-top:7px">${t?'Изменить действие':'Добавить действие'}</h2></div><button class="modal-close" data-action="close-modal" aria-label="Закрыть">×</button></div><form id="task-form" class="form-stack"><div class="field"><label class="field-label">Что конкретно сделать?</label><input name="title" class="input" value="${attr(t?.title||'')}" required maxlength="600" placeholder="Одно наблюдаемое действие"></div><div class="field"><label class="field-label">Готово, когда…</label><textarea name="doneWhen" class="textarea compact" placeholder="Как понять, что действие закончено?">${h(t?.doneWhen||'')}</textarea></div><div class="grid-fields"><div class="field"><label class="field-label">К какой долгосрочной цели относится?</label><select class="select" name="goalId"><option value="0" ${!t?.goalId?'selected':''}>Входящие · определить позже</option>${data.goals.map(g=>`<option value="${g.id}" ${Number(t?.goalId||0)===Number(g.id)?'selected':''}>${g.id}. ${h(first(g.vision,48))}</option>`).join('')}</select></div><div class="field"><label class="field-label">До какой даты?</label><input name="due" class="input" type="date" value="${attr(t?.due||'')}"></div></div><div class="grid-fields"><div class="field"><label class="field-label">Сколько блоков по 30 минут?</label><input name="blocks" class="input" type="number" min="0" max="100" value="${attr(t?.blocks??'')}"></div><div class="field"><label class="field-label">Необходимые силы</label><select name="energy" class="select">${['Низкая','Средняя','Высокая'].map(v=>`<option ${v===(t?.energy||'Средняя')?'selected':''}>${v}</option>`).join('')}</select></div></div><div class="field"><label class="field-label">Состояние</label><select name="status" class="select">${['Входящие','Следующий шаг','В работе','Жду ответа','Готово','Пауза'].map(v=>`<option ${v===(t?.status||'Входящие')?'selected':''}>${v}</option>`).join('')}</select></div><div class="field"><label class="field-label">Проект (если есть)</label><select class="select" name="projectId"><option value="">Без проекта</option>${data.projects.map(p=>`<option value="${attr(p.id)}" ${p.id===t?.projectId?'selected':''}>${h(p.title)}</option>`).join('')}</select></div><div class="field"><label class="field-label">С чего проще начать?</label><input class="input" name="nextStep" value="${attr(t?.nextStep||'')}" placeholder="Самый маленький шаг"></div><div class="field"><label class="field-label">Заметки</label><textarea name="notes" class="textarea compact">${h(t?.notes||'')}</textarea></div><div class="row-actions"><button class="button primary" type="submit">Сохранить шаг</button>${t?'<button type="button" class="button danger" data-action="delete-task" data-id="'+attr(t.id)+'">Удалить</button>':''}</div></form></section></div>`;
    }
    if(modal.type==='project'){
      const p=data.projects.find(x=>x.id===modal.id);
      return `<div class="modal-overlay" data-action="close-overlay"><section class="modal" role="dialog" aria-modal="true" aria-label="Проект"><div class="modal-head"><h2>${p?'Изменить проект':'Создать проект'}</h2><button class="modal-close" data-action="close-modal">×</button></div><form id="project-form" class="form-stack"><div class="field"><label class="field-label">Название проекта</label><input class="input" name="title" value="${attr(p?.title||'')}" required maxlength="180" placeholder="Например: Портфолио на английском"></div><div class="field"><label class="field-label">Какой законченный результат нужен?</label><textarea class="textarea" name="description" placeholder="Что будет готово и зачем?">${h(p?.description||'')}</textarea></div><div class="field"><label class="field-label">Связанная долгосрочная цель</label><select class="select" name="goalId"><option value="0">Пока без привязки</option>${data.goals.map(g=>`<option value="${g.id}" ${Number(p?.goalId)===Number(g.id)?'selected':''}>${g.id}. ${h(first(g.vision,70))}</option>`).join('')}</select></div><div class="field"><label class="field-label">Состояние</label><select class="select" name="status">${['В планах','В работе','Пауза','Готово'].map(x=>`<option ${x===(p?.status||'В планах')?'selected':''}>${x}</option>`).join('')}</select></div><button type="submit" class="button primary">Сохранить проект</button></form></section></div>`;
    }
    if(modal.type==='stuck'){
      const t=data.tasks.find(x=>x.id===modal.id);if(!t)return '';
      return `<div class="modal-overlay" data-action="close-overlay"><section class="modal" role="dialog" aria-modal="true" aria-label="Что мешает начать"><div class="modal-head"><div><div class="eyebrow">ПОМОЩЬ С ЗАДАЧЕЙ</div><h2>${h(first(t.title,100))}</h2></div><button class="modal-close" data-action="close-modal">×</button></div><form id="stuck-form" class="form-stack"><div class="field"><label class="field-label">Что сейчас мешает?</label><select class="select" name="blocker"><option value="Не понимаю, с чего начать">Не понимаю, с чего начать</option><option value="Задача слишком большая">Задача слишком большая</option><option value="Не хватает сил">Не хватает сил</option><option value="Жду другого человека">Жду ответа или действия другого человека</option><option value="Уже не приоритет">Сейчас это не приоритет</option></select></div><div class="field"><label class="field-label">Самый маленький следующий шаг</label><textarea class="textarea" name="nextStep" placeholder="Например: открыть прошлые заметки и выписать 3 факта">${h(t.nextStep||'')}</textarea><p class="help">Можно оставить пустым. Не нужно составлять подробный план, если сейчас нет сил.</p></div><button class="button primary" type="submit">Сохранить и вернуться</button></form></section></div>`;
    }
    if(modal.type==='capture')return `<div class="modal-overlay" data-action="close-overlay"><section class="modal" role="dialog" aria-modal="true" aria-label="Голосовой ввод"><div class="modal-head"><div><div class="eyebrow">БЫСТРАЯ ЗАПИСЬ</div><h2>Сказать или написать</h2></div><button class="modal-close" data-action="close-modal">×</button></div><form id="capture-form" class="form-stack"><p class="muted">Нажми микрофон, произнеси фразу по-русски или используй диктовку клавиатуры. Перед сохранением проверь сумму, валюту и дату.</p><div class="row-actions"><button class="button" type="button" data-action="start-dictation">🎙 Надиктовать</button><span class="small muted" id="voice-status">Если кнопка недоступна, печатай или используй микрофон клавиатуры.</span></div><div class="field"><label class="field-label">Что записать?</label><textarea class="textarea" name="utterance" id="spoken-text" placeholder="Например: потратила 25 евро на продукты или отправить предложение в пятницу" required>${h(voiceDraft)}</textarea></div><div class="field"><label class="field-label">Тип записи</label><select class="select" name="kind" id="capture-kind"><option value="task" ${modal.kind==='task'?'selected':''}>Задача</option><option value="expense" ${modal.kind==='expense'?'selected':''}>Расход</option><option value="note" ${modal.kind==='note'?'selected':''}>Заметка на сегодня</option></select></div><div class="grid-fields"><div class="field"><label class="field-label">Дата (проверь)</label><input class="input" name="date" type="date" value="${modal.kind==='expense'?today():''}"></div><div class="field"><label class="field-label">Цель для задачи</label><select class="select" name="goalId"><option value="0">Входящие, разберу позже</option>${data.goals.map(g=>`<option value="${g.id}">${g.id}. ${h(first(g.vision,45))}</option>`).join('')}</select></div></div><div class="grid-fields"><div class="field"><label class="field-label">Сумма расхода, если это расход</label><input class="input" name="amount" type="number" min="0" step="0.01" placeholder="25"></div><div class="field"><label class="field-label">Валюта</label><select class="select" name="currency"><option value="">Указать валюту</option><option>EUR</option><option>GEL</option><option>RUB</option><option>USD</option></select></div></div><button class="button primary" type="submit">Проверила — сохранить</button><p class="small muted">Распознавание речи может обрабатываться сервисами браузера. Для чувствительных сведений используй обычный текстовый ввод.</p></form></section></div>`;
    if(modal.type==='chat')return `<div class="modal-overlay" data-action="close-overlay"><section class="modal" role="dialog" aria-modal="true" aria-label="Изменения из ChatGPT"><div class="modal-head"><div><div class="eyebrow">СОВМЕСТНАЯ РАБОТА</div><h2>Изменения из ChatGPT</h2></div><button class="modal-close" data-action="close-modal">×</button></div><form id="chat-patch-form" class="form-stack"><p class="muted">Вставь сюда пакет изменений, который мы составили после разговора. Сначала появится предварительный просмотр.</p><textarea class="textarea" name="payload" rows="8" required placeholder='{ "type": "next-chapter-patch", "version": 1, "changes": [...] }'>${h(modal.raw||'')}</textarea><button class="button primary" type="submit">Проверить изменения</button></form></section></div>`;
    if(modal.type==='patch-preview'&&pendingPatch){return `<div class="modal-overlay" data-action="close-overlay"><section class="modal" role="dialog" aria-modal="true" aria-label="Предварительный просмотр"><div class="modal-head"><div><h2>Проверить перед сохранением</h2></div><button class="modal-close" data-action="close-modal">×</button></div><p class="muted">${pendingPatch.changes.length} изменений. Ничего не записывается до подтверждения.</p>${pendingPatch.changes.map(c=>`<div class="task-check"><div><strong>${h(c.op==='add_task'?'Задача':c.op==='add_expense'?'Расход':'Изменение задачи')}</strong><p class="small muted">${h(c.op==='add_task'?c.title:c.op==='add_expense'?`${c.date} · ${c.amount} ${c.currency} · ${c.category||''}`:`${c.id}: ${c.status}`)}</p></div></div>`).join('')}<div class="row-actions" style="margin-top:16px"><button class="button primary" data-action="confirm-patch">Добавить эти изменения</button><button class="button" data-action="close-modal">Отменить</button></div></section></div>`;}
    return '';
  }
  function renderAuth(message=''){
    const reset=authMode==='reset',recovery=authMode==='recovery';
    const heading=recovery?'Новый пароль':reset?'Восстановить доступ':authMode==='login'?'Добро пожаловать':'Создать личный вход';
    let form='';
    if(recovery)form=`<form id="auth-new-password" class="form-stack" style="margin-top:23px"><div class="field"><label class="field-label">Новый пароль</label><input class="input" name="password" type="password" minlength="8" required autocomplete="new-password"></div><button class="button primary block" type="submit">Сохранить новый пароль</button></form>`;
    else if(reset)form=`<form id="auth-reset" class="form-stack" style="margin-top:23px"><div class="field"><label class="field-label">Email</label><input class="input" type="email" name="email" autocomplete="email" required placeholder="your@email.com"></div><button class="button primary block" type="submit">Отправить ссылку</button></form><div class="auth-switch"><button class="button ghost sm" data-action="show-login">Назад ко входу</button></div>`;
    else form=`<form id="auth-form"><div class="field"><label class="field-label">Email</label><input class="input" name="email" type="email" autocomplete="email" required placeholder="your@email.com"></div><div class="field"><label class="field-label">Пароль</label><input class="input" name="password" type="password" minlength="8" autocomplete="${authMode==='login'?'current-password':'new-password'}" required placeholder="Минимум 8 символов"></div><button class="button primary block" type="submit">${authMode==='login'?'Войти':'Зарегистрироваться'}</button></form><div class="auth-switch"><button class="button ghost sm" type="button" data-action="toggle-auth">${authMode==='login'?'Нет учётной записи? Создать':'Уже есть учётная запись? Войти'}</button>${authMode==='login'?`<button class="button ghost sm" type="button" data-action="show-reset">Забыли пароль?</button>`:''}</div>`;
    return `<div class="auth-screen"><section class="auth-card"><div class="logo">∿</div><div class="eyebrow" style="margin-top:20px">МОЯ СЛЕДУЮЩАЯ ГЛАВА</div><h1>${heading}</h1><p class="muted" style="margin-top:8px">${recovery?'Придумай новый пароль для своего кабинета.':reset?'Пришлю ссылку для создания нового пароля.':'Твоя стратегия, шаги и финансовый прогноз синхронизируются между устройствами.'}</p>${message?`<div class="notice" style="margin-top:15px">${h(message)}</div>`:''}${form}<p class="small muted" style="margin-top:22px">Данные защищаются правилами доступа в Supabase. Пароль не хранится в коде сайта.</p></section></div>`;
  }
  function render(){
    if(HAS_CLOUD&&mode==='loading'){root.innerHTML='<div class="startup">Подключаю защищённое хранилище…</div>';return}
    if(HAS_CLOUD&&mode==='setup-error'){root.innerHTML='<div class="auth-screen"><div class="auth-card"><h2>Не удалось подключить облако</h2><p class="muted" style="margin-top:10px">Проверь конфигурацию Supabase, доступ к интернету и загрузку библиотеки supabase-js. Личные данные сейчас не отображаются.</p><button class="button" style="margin-top:20px" onclick="location.reload()">Повторить</button></div></div>';return}
    if(HAS_CLOUD&&(!session||authMode==='recovery'||authMode==='reset')){root.innerHTML=renderAuth();return}
    root.innerHTML=shell()+renderModal()+`<input id="import-file" type="file" accept="application/json,.json" hidden>`;
  }
  async function fetchRemote(opts={}){
    if(!api||!session)return;
    const {data:row,error}=await api.from('personal_workspaces').select('data,revision,updated_at').eq('user_id',session.user.id).maybeSingle();
    if(error)throw new Error('Не удаётся прочитать личное хранилище: '+error.message);
    if(row){
      if(dirty&&!opts.force){conflict=true;syncState='Конфликт изменений';render();return}
      data=normalize(row.data);revision=Number(row.revision)||0;dirty=false;conflict=false;syncState='Синхронизировано';
    }else if(opts.force){data=blank();revision=0;dirty=false;conflict=false;syncState='Облако пока пустое'}
    else {data=blank();revision=0;dirty=false;conflict=false;syncState='Облако готово'}
    render();
  }
  async function saveCloud(){
    if(!HAS_CLOUD||mode!=='ready'||!session||isSaving||conflict||!dirty)return;
    isSaving=true;const atStart=localChanges;
    const payload=JSON.parse(JSON.stringify(data));
    try{
      const {data:result,error}=await api.rpc('save_personal_workspace',{payload,expected_revision:revision});
      if(error)throw new Error(error.message);
      const row=Array.isArray(result)?result[0]:result;
      if(!row)throw new Error('Сервер не вернул номер версии');
      if(row.conflict){conflict=true;syncState='Конфликт изменений';notify('На другом устройстве сохранена новая версия. Проверь синхронизацию.');render();return}
      revision=Number(row.new_revision);dirty=atStart!==localChanges;syncState=dirty?'Сохраняю…':'Синхронизировано';
      renderSyncLabel();
    }catch(err){syncState='Ошибка синхронизации';console.error(err);notify('Не удалось сохранить в облаке. Скачай резервную копию из настроек.');renderSyncLabel()}
    finally{isSaving=false;if(dirty&&!conflict&&syncState!=='Ошибка синхронизации'){clearTimeout(saveTimer);saveTimer=setTimeout(saveCloud,500)}}
  }
  function setupRealtime(){
    if(!api||!session)return;
    if(listening){api.removeChannel(listening);listening=null}
    listening=api.channel('my-workspace-'+session.user.id)
      .on('postgres_changes',{event:'*',schema:'public',table:'personal_workspaces',filter:'user_id=eq.'+session.user.id},async payload=>{
        const remoteRevision=Number(payload.new?.revision||0);
        if(remoteRevision>revision&&!isSaving){try{await fetchRemote()}catch(e){console.error(e)}}
      }).subscribe();
  }
  async function loggedIn(){
    mode='loading';render();
    try{await fetchRemote({force:true});mode='ready';setupRealtime();render()}
    catch(e){mode='setup-error';console.error(e);render();notify(e.message)}
  }
  async function init(){
    if(!HAS_CLOUD){render();return}
    if(!window.supabase?.createClient){
      try { await new Promise((resolve,reject)=>{
        const script=document.createElement('script');script.src='https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js';
        script.onload=resolve;script.onerror=()=>reject(new Error('Библиотека Supabase недоступна'));
        document.head.append(script);setTimeout(()=>reject(new Error('Превышено время подключения Supabase')),12000);
      }); } catch(error){mode='setup-error';console.error(error);render();return}
    }
    try{
      api=window.supabase.createClient(CFG.supabaseUrl,CFG.supabaseAnonKey,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}});
      const {data:s,error}=await api.auth.getSession();if(error)throw error;
      session=s?.session||null;
      if(session)await loggedIn();else{mode='auth';render()}
      api.auth.onAuthStateChange(async(event,next)=>{
        if(event==='SIGNED_OUT'){session=null;data=blank();revision=0;mode='auth';authMode='login';if(listening)api.removeChannel(listening);listening=null;render()}
        if(event==='PASSWORD_RECOVERY'){session=next;authMode='recovery';mode='auth';render();return}
        if(event==='SIGNED_IN'&&next&&!session){session=next;await loggedIn()}
      });
      window.addEventListener('online',()=>{if(session&&dirty&&!isSaving&&!conflict)saveCloud()});
      window.addEventListener('focus',async()=>{if(session&&mode==='ready'&&!dirty){try{const {data:r,error}=await api.from('personal_workspaces').select('revision').eq('user_id',session.user.id).maybeSingle();if(!error&&r&&Number(r.revision)>revision)await fetchRemote()}catch(e){console.error(e)}}});
    }catch(e){mode='setup-error';console.error(e);render()}
  }
  async function importFile(file){
    if(!file)return;
    if(file.size>6*1024*1024){notify('Файл слишком большой. Максимум 6 МБ.');return}
    let incoming;
    try{incoming=JSON.parse(await file.text());if(!incoming||!Array.isArray(incoming.goals)||!Array.isArray(incoming.tasks)||!Array.isArray(incoming.weeks))throw Error('Это не файл стратегии')}
    catch(e){notify('Не удалось прочитать файл стратегии. Проверь формат JSON.');return}
    if(data.goals.length||data.tasks.length){exportData();if(!window.confirm('ВНИМАНИЕ: Скачана резервная копия. Восстановление целиком заменит текущие данные, включая новые IELTS-уроки и заметки. Ты действительно хочешь заменить всё?'))return;}
    data=normalize(incoming);currentWeek=-1;view='today';modal=null;
    markChange(true);notify('Стратегия импортирована. Изменения сохраняются.');
  }
  async function processChange(el){
    const b=el.dataset.bind;if(!b)return;
    let p=b.split(':'),type=p[0],value=el.value;
    if(type==='add-today'){
      if(!value)return;const k=today();let d=data.daily[k]||(data.daily[k]={energy:'обычно',main:'',fallback:'',extra:'',care:'',note:'',taskIds:[]});
      d.taskIds=Array.isArray(d.taskIds)?d.taskIds:[];if(!d.taskIds.includes(value))d.taskIds.push(value);markChange();return;
    }
    if(type==='history-date'||type==='saved-day'){
      if(validISO(value)&&value<=today()){selectedDailyDate=value;render()}
      return;
    }
    if(type==='archive'){
      const k=selectedDailyDate;if(!validISO(k)||k>=today())return;
      const d=data.daily[k]||(data.daily[k]={energy:'обычно',taskIds:[]});d[p[1]]=value;markChange(false);return;
    }
    if(type==='task-filter-goal'){goalFilter=value;render();return}
    if(type==='task-filter-project'){projectFilter=value;render();return}
    if(type==='daily'){
      const k=today();let d=data.daily[k]||(data.daily[k]={energy:'обычно',taskIds:[]});d[p[1]]=value;markChange(false);return;
    }
    if(type==='week'){
      const w=week();if(!w)return;w[p[1]]=p[1]==='hours'?(value===''?'':Number(value)):value;markChange(false);return;
    }
    if(type==='goal'){
      const g=byGoal(p[1]);if(!g)return;g[p[2]]=value;markChange(false);return;
    }
    if(type==='quarter'){
      let q=data.quarters.find(q=>q.id===p[1]);if(!q)return;q[p[2]]=value;markChange(false);return;
    }
    if(type==='money'){
      let m=data.finances.find(m=>m.id===p[1]);if(!m)return;m[p[2]]=value===''?null:Number(value);markChange(true);return;
    }
    if(type==='review-month'){selectedReviewMonth=value;render();return}
    if(type==='review'){
      let k=selectedReviewMonth,r=data.reviews[k]||(data.reviews[k]={});r[p[1]]=value;markChange(false);return;
    }
  }
  root.addEventListener('change',e=>{if(e.target.dataset.bind)processChange(e.target)});
  // Сохраняем длинные заметки во время набора, даже до потери фокуса.
  root.addEventListener('input',e=>{if(e.target.tagName==='TEXTAREA'&&e.target.dataset.bind)processChange(e.target);if(e.target.id==='spoken-text')updateCaptureFields(e.target.value)});
  root.addEventListener('click',async e=>{
    const btn=e.target.closest('[data-action]');if(!btn)return;
    const action=btn.dataset.action,id=btn.dataset.id;
    if(action==='close-overlay'&&e.target!==btn)return;
    if(action==='quick-capture'||action==='capture-inbox'){voiceDraft='';modal={type:'capture',kind:action==='capture-inbox'?'task':view==='finances'?'expense':'task'};render();return}
    if(action==='chat-import'){modal={type:'chat'};render();return}
    if(action==='confirm-patch'){if(!pendingPatch)return;applyPatch(pendingPatch);pendingPatch=null;modal=null;markChange();notify('Изменения добавлены. Проверь сохранение.');return}
    if(action==='check-suggestion'){let d=data.daily[today()]||(data.daily[today()]={energy:'обычно',taskIds:[]});if(!Array.isArray(d.completedSuggestions))d.completedSuggestions=[];d.completedSuggestions=btn.checked?[...new Set([...d.completedSuggestions,id])]:d.completedSuggestions.filter(x=>x!==id);markChange();return}
    if(action==='delete-transaction'){if(!window.confirm('Удалить эту запись о расходе?'))return;data.transactions=data.transactions.filter(x=>x.id!==id);markChange();return}
    if(action==='start-dictation'){
      const R=window.SpeechRecognition||window.webkitSpeechRecognition;
      if(!R){notify('Браузер не поддерживает распознавание. Используй микрофон клавиатуры.');return}
      try{if(voiceRecognition)voiceRecognition.abort();voiceRecognition=new R();voiceRecognition.lang='ru-RU';voiceRecognition.continuous=false;voiceRecognition.interimResults=false;const box=$('spoken-text'), status=$('voice-status');if(status)status.textContent='Слушаю…';voiceRecognition.onresult=e=>{let spoken=Array.from(e.results).map(v=>v[0].transcript).join(' ');if(box){box.value=(box.value?box.value+' ':'')+spoken;voiceDraft=box.value;const parsed=parseVoiceMoney(box.value);if(parsed){const amt=root.querySelector('#capture-form [name="amount"]'),curr=root.querySelector('#capture-form [name="currency"]'),kind=$('capture-kind');if(amt&&!amt.value)amt.value=parsed.amount;if(curr)curr.value=parsed.currency;if(kind)kind.value='expense';}updateCaptureFields(box.value);}if(status)status.textContent='Проверь распознанный текст и данные';};voiceRecognition.onerror=e=>{if(status)status.textContent='Не удалось распознать речь: '+e.error+'. Можно печатать.';};voiceRecognition.start();}catch(err){notify('Не получилось включить микрофон. Используй клавиатуру.')}return;
    }
    if(action==='tab'){view=id||'weeks';modal=null;render();window.scrollTo(0,0);return}
    if(action==='close-modal'||action==='close-overlay'){modal=null;render();return}
    if(action==='prev-day'||action==='next-day'){
      const d=dateLocal(selectedDailyDate);d.setDate(d.getDate()+(action==='prev-day'?-1:1));
      const k=todayFromDate(d);if(k<=today()){selectedDailyDate=k;render()};return;
    }
    if(action==='go-today'){selectedDailyDate=today();render();return}
    if(action==='archive-energy'){
      const k=selectedDailyDate;if(!validISO(k)||k>=today())return;
      const d=data.daily[k]||(data.daily[k]={energy:'обычно',taskIds:[]});d.energy=id;markChange();return;
    }
    if(action==='prev-week'||action==='next-week'){let i=getWeekIndex()+(action==='prev-week'?-1:1);currentWeek=Math.max(0,Math.min(data.weeks.length-1,i));render();return}
    if(action==='current-week'){currentWeek=-1;render();return}
    if(action==='go-current-week'){currentWeek=-1;view='weeks';render();return}
    if(action==='goal'){modal={type:'goal',id:Number(id)};render();return}
    if(action==='new-project'){modal={type:'project'};render();return}
    if(action==='edit-project'){modal={type:'project',id};render();return}
    if(action==='project-detail'){view='tasks';projectFilter=id;goalFilter='Все';taskFilter='Все';modal=null;render();return}
    if(action==='stuck-task'){modal={type:'stuck',id};render();return}
    if(action==='copy-ielts-prompt'){navigator.clipboard?.writeText('Я выполняю урок IELTS Academic 7.5. Помоги сначала разобраться в критериях задания на основе официального источника, затем проверь мой ответ, объясни ошибки и предложи короткую тренировку. Не выдавай учебную оценку за официальный балл экзамена.');notify('Запрос скопирован для ChatGPT');return}
    if(action==='new-task'){modal={type:'task',id:null};render();return}
    if(action==='edit-task'){modal={type:'task',id};render();return}
    if(action==='task-filter'){taskFilter=id;render();return}
    if(action==='energy'){const d=data.daily[today()]||(data.daily[today()]={energy:'обычно',taskIds:[]});d.energy=id;markChange();return}
    if(action==='remove-today-task'){let d=data.daily[today()];if(d){d.taskIds=(d.taskIds||[]).filter(x=>x!==id);markChange()}return}
    if(action==='check-task'){const t=data.tasks.find(x=>x.id===id);if(t){t.status=btn.checked?'Готово':'Следующий шаг';t.completedAt=btn.checked?today():'';markChange()}return}
    if(action==='delete-task'){
      if(!window.confirm('Удалить этот шаг из плана?'))return;
      data.tasks=data.tasks.filter(t=>t.id!==id);for(const d of Object.values(data.daily))d.taskIds=(d.taskIds||[]).filter(x=>x!==id);modal=null;markChange();notify('Шаг удалён');return;
    }
    if(action==='export'){exportData();return}
    if(action==='trigger-import'){const i=$('import-file');if(i){i.click()}return}
    if(action==='reload-cloud'){if(HAS_CLOUD&&api&&session){if(dirty&&!window.confirm('Есть изменения, которые ещё не сохранились. Сначала скачай резервную копию. Всё равно загрузить облачную версию?'))return;try{await fetchRemote({force:true});notify('Облачная версия загружена')}catch(e){notify(e.message)}}return}
    if(action==='logout'){if(api){if(dirty){notify('Подожди, пока синхронизация завершится, или скачай резервную копию.');return}await api.auth.signOut()}return}
    if(action==='toggle-auth'){authMode=authMode==='login'?'signup':'login';render();return}
    if(action==='show-reset'){authMode='reset';render();return}
    if(action==='show-login'){authMode='login';render();return}
  });
  root.addEventListener('submit',async e=>{
    if(e.target.id==='auth-reset'){
      e.preventDefault();const email=String(new FormData(e.target).get('email')||'').trim();
      try{const r=await api.auth.resetPasswordForEmail(email,{redirectTo:window.location.origin+window.location.pathname});if(r.error)throw r.error;root.innerHTML=renderAuth('Если адрес зарегистрирован, письмо со ссылкой для смены пароля скоро придёт.')}catch(err){root.innerHTML=renderAuth(err.message)}return;
    }
    if(e.target.id==='auth-new-password'){
      e.preventDefault();const password=String(new FormData(e.target).get('password')||'');
      try{const r=await api.auth.updateUser({password});if(r.error)throw r.error;authMode='login';await loggedIn();notify('Пароль обновлён')}catch(err){root.innerHTML=renderAuth(err.message)}return;
    }
    if(e.target.id==='auth-form'){
      e.preventDefault();const f=new FormData(e.target);const email=String(f.get('email')||'').trim(),password=String(f.get('password')||'');let submit=e.target.querySelector('[type="submit"]');submit.disabled=true;submit.textContent='Подождите…';
      try{
        const res=authMode==='login'?await api.auth.signInWithPassword({email,password}):await api.auth.signUp({email,password});
        if(res.error)throw res.error;
        if(res.data.session){session=res.data.session;await loggedIn()}
        else {root.innerHTML=renderAuth('Проверь почту и подтвердите адрес. После подтверждения войди с email и паролем.');}
      }catch(err){root.innerHTML=renderAuth(err.message||'Ошибка входа. Проверь данные.')}
      return;
    }
    if(e.target.id==='chat-patch-form'){
      e.preventDefault();const raw=String(new FormData(e.target).get('payload')||'');try{pendingPatch=parsePatch(raw);modal={type:'patch-preview'};render()}catch(err){notify(err.message||'Неверный формат пакета')};return;
    }
    if(e.target.id==='capture-form'){
      e.preventDefault();const f=new FormData(e.target),kind=f.get('kind'), utterance=String(f.get('utterance')||'').trim(), date=String(f.get('date')||'');
      if(!utterance||(date&&!validISO(date))){notify('Проверь текст и дату');return}
      if(kind==='task'){let goalId=Number(f.get('goalId')||0);data.tasks.push({id:guid('T'),goalId,category:byGoal(goalId)?.category||'Входящие',title:utterance,due:date,status:goalId?'Следующий шаг':'Входящие',notes:'Добавлено через быструю запись'});}
      else if(kind==='note'){let noteDate=date||today();let d=data.daily[noteDate]||(data.daily[noteDate]={energy:'обычно',taskIds:[]});d.note=[d.note,utterance].filter(Boolean).join('\n');}
      else{const parsed=parseVoiceMoney(utterance),amount=Number(f.get('amount')||parsed?.amount),currency=String(f.get('currency')||parsed?.currency||'');if(!(amount>0)||!['EUR','GEL','RUB','USD'].includes(currency)){notify('Для расхода укажи сумму и валюту');return}data.transactions.push({id:guid('X'),date:date||today(),amount,currency,category:'Другое',note:utterance,source:'Голос / текст'});}
      voiceDraft='';modal=null;markChange();notify('Запись сохранена');return;
    }
    if(e.target.id==='project-form'){
      e.preventDefault();const f=new FormData(e.target),title=String(f.get('title')||'').trim();if(!title)return notify('Нужно название проекта');
      const old=modal?.id?data.projects.find(p=>p.id===modal.id):null;
      const p={...(old||{}),id:old?.id||guid('P'),title,description:String(f.get('description')||''),goalId:Number(f.get('goalId')||0),status:String(f.get('status')||'В планах')};
      if(old)Object.assign(old,p);else data.projects.push(p);
      modal=null;markChange();return;
    }
    if(e.target.id==='stuck-form'){
      e.preventDefault();const t=data.tasks.find(x=>x.id===modal?.id);if(!t)return;
      const f=new FormData(e.target);t.blocker=String(f.get('blocker')||'');t.nextStep=String(f.get('nextStep')||'').slice(0,600);
      if(t.blocker==='Жду другого человека')t.status='Жду ответа';
      if(t.blocker==='Уже не приоритет')t.status='Пауза';
      modal=null;markChange();notify('Сохранила. Можно вернуться позже.');return;
    }
    if(e.target.id==='task-form'){
      e.preventDefault();const f=new FormData(e.target);const title=String(f.get('title')||'').trim();if(!title){notify('Добавь название действия');return}
      const goalId=Number(f.get('goalId')||0);const old=modal?.id?data.tasks.find(t=>t.id===modal.id):null;
      const t={...(old||{}),id:old?.id||guid('T'),goalId,category:byGoal(goalId)?.category||'Входящие',title,doneWhen:String(f.get('doneWhen')||''),blocks:String(f.get('blocks')||''),due:String(f.get('due')||''),energy:String(f.get('energy')||'Средняя'),status:String(f.get('status')||'Следующий шаг'),projectId:String(f.get('projectId')||''),nextStep:String(f.get('nextStep')||''),notes:String(f.get('notes')||'')};
      if(t.status==='Готово'&&!t.completedAt)t.completedAt=today();if(t.status!=='Готово')t.completedAt='';
      if(old)Object.assign(old,t);else data.tasks.push(t);modal=null;markChange();notify('Шаг сохранён');return;
    }
  });
  root.addEventListener('change',async e=>{
    if(e.target.id==='import-file'){await importFile(e.target.files?.[0]);e.target.value=''}
  });
  document.addEventListener('keydown',e=>{if(e.key==='Escape'&&modal){modal=null;render()}});
  init();
})();
