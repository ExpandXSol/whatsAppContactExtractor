(() => {
  if (window.__tejoERPWhatsAppExtractorV5) return;
  window.__tejoERPWhatsAppExtractorV5 = true;

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  let latestRows = [];
  let latestStatus = {scanning:false,done:false,contactCount:0,scanned:0,progress:0};
  let scanPromise = null;

  function send(data) {
    latestStatus = {...latestStatus,...data};
    chrome.runtime.sendMessage({type:"TEJO_SCAN_STATUS",data:latestStatus}).catch(()=>{});
  }

  function visible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    const r=el.getBoundingClientRect(), s=getComputedStyle(el);
    return r.width>0 && r.height>0 && s.display!=="none" &&
      s.visibility!=="hidden" && Number(s.opacity)!==0;
  }

  function groupInfoText() {
    const text = [...document.querySelectorAll("header,main,[role='main'],div")]
      .filter(visible)
      .map(el => (el.innerText||"").trim())
      .filter(t => t && t.length < 500 && /members?/i.test(t));
    // Prefer the smallest useful text block containing the group header/member count.
    text.sort((a,b)=>a.length-b.length);
    return text[0] || "";
  }

  function getGroupName() {
    // WhatsApp group title is usually visible in the chat header or group-info header.
    const candidates = [...document.querySelectorAll("header span[title],header [title], [role='main'] header span, [role='main'] header div")]
      .filter(visible);
    for (const el of candidates) {
      const t=(el.getAttribute("title") || el.innerText || "").trim();
      if (t && t.length < 100 && !/^\d+ members?$/i.test(t) && !/search/i.test(t)) return t;
    }
    const txt=groupInfoText();
    const line=txt.split(/\n+/).map(x=>x.trim()).find(x=>x && !/^\d+\s+members?$/i.test(x) && !/^(group info|media, links and docs)$/i.test(x));
    return line || "Selected WhatsApp group";
  }

  function getMemberCount() {
    const text = document.body.innerText || "";
    const matches = [...text.matchAll(/\b(\d{1,5})\s+members?\b/gi)];
    if (matches.length) return Math.max(...matches.map(m=>Number(m[1])));
    const more = text.match(/View all\s*\(\s*(\d+)\s+more\s*\)/i);
    return more ? Number(more[1]) : null;
  }

  function findViewAll() {
    const nodes=[...document.querySelectorAll("button,[role='button'],div,span,a")]
      .filter(visible)
      .map(el=>({el,t:(el.innerText||el.textContent||"").trim()}))
      .filter(x=>/^view all\s*\(\s*\d+\s+more\s*\)$/i.test(x.t));
    nodes.sort((a,b)=>{
      const ra=a.el.getBoundingClientRect(),rb=b.el.getBoundingClientRect();
      return ra.width*ra.height-rb.width*rb.height;
    });
    return nodes[0]?.el || null;
  }

  function findMembersDialog() {
    const heads=[...document.querySelectorAll("h1,h2,h3,[role='heading'],div,span")]
      .filter(visible)
      .filter(el=>(el.innerText||el.textContent||"").trim()==="Search members");
    for (const heading of heads) {
      let el=heading;
      for(let i=0;el&&i<14;i++,el=el.parentElement) {
        if(!visible(el)) continue;
        const r=el.getBoundingClientRect();
        if(r.width>=260&&r.height>=260&&r.width<window.innerWidth*.92&&r.height<window.innerHeight*.99) {
          return el;
        }
      }
    }
    return [...document.querySelectorAll("[role='dialog']")].find(d=>visible(d)&&(d.innerText||"").includes("Search members")) || null;
  }

  function findDialogScroller(dialog) {
    if(!dialog) return null;
    const candidates=[dialog,...dialog.querySelectorAll("div,[role='list'],[role='listbox']")]
      .filter(visible)
      .filter(el=>{
        const s=getComputedStyle(el);
        return el.scrollHeight>el.clientHeight+40 &&
          /(auto|scroll)/.test(s.overflowY) &&
          el.clientHeight>100 && el.clientWidth>150;
      });
    candidates.sort((a,b)=>b.scrollHeight-a.scrollHeight);
    return candidates[0] || null;
  }

  const phoneRe=/(?:\+\s?\d{1,3}[\s().-]*)?(?:\d[\d\s().-]{7,}\d)/g;
  const digits=s=>String(s).replace(/\D/g,"");
  function normalizePhone(raw) {
    let n=String(raw).replace(/[^\d+]/g,"");
    if(n.startsWith("00")) n="+"+n.slice(2);
    if(!n.startsWith("+") && /^\d{10}$/.test(n)) n="+91"+n;
    return n;
  }
  function extractPhones(text) {
    const out=[];
    for(const m of (text||"").matchAll(phoneRe)) {
      const p=normalizePhone(m[0]),d=digits(p);
      if(d.length>=10&&d.length<=15) out.push(p);
    }
    return [...new Set(out)];
  }

  function collectDialog(dialog,map) {
    // Every inspected element is a descendant of the Search members popup.
    const elements=[dialog,...dialog.querySelectorAll("div,span,[role='listitem'],[role='button']")];
    for(const el of elements) {
      if(!visible(el)) continue;
      const text=(el.innerText||"").trim();
      if(!text || text.length>420) continue;
      const phones=extractPhones(text);
      if(!phones.length) continue;
      const lines=text.split(/\n+/).map(x=>x.trim()).filter(Boolean);
      for(const phone of phones) {
        const name=lines.find(line=>line.length<=100 && extractPhones(line).length===0 &&
          !/^(search members|search contacts|add member tag|group admin|admin|you)$/i.test(line)) || "";
        if(!map.has(phone) || (!map.get(phone).name && name)) map.set(phone,{name,phone});
      }
    }
  }

  async function waitForDialog(timeout=12000) {
    const end=Date.now()+timeout;
    while(Date.now()<end) {
      const dialog=findMembersDialog();
      if(dialog) return dialog;
      await sleep(250);
    }
    return null;
  }

  function downloadCsv() {
    if(!latestRows.length) return false;
    const cell=v=>'"'+String(v??"").replace(/"/g,'""')+'"';
    const csv=[["Name","Phone Number"],...latestRows.map(r=>[r.name,r.phone])]
      .map(row=>row.map(cell).join(",")).join("\r\n");
    const blob=new Blob(["\uFEFF"+csv],{type:"text/csv;charset=utf-8"});
    const url=URL.createObjectURL(blob);
    const a=document.createElement("a");
    a.href=url;
    a.download="tejoerp-whatsapp-group-contacts.csv";
    document.body.appendChild(a);a.click();a.remove();
    setTimeout(()=>URL.revokeObjectURL(url),5000);
    return true;
  }

  async function runScan() {
    const groupName=getGroupName();
    const memberCount=getMemberCount();
    send({groupName,memberCount,scanning:true,done:false,progress:0,scanned:0,contactCount:0,
      title:"Opening participant list…",note:"Looking for the group's View all control.",error:null});

    let dialog=findMembersDialog();
    if(!dialog) {
      const viewAll=findViewAll();
      if(!viewAll) {
        send({scanning:false,done:true,error:"Open the group's info panel first; the extension could not find “View all (N more)”.",title:"Group info not found."});
        return;
      }
      viewAll.click();
      send({title:"Opening Search members…",note:"Waiting for WhatsApp to display the participant list."});
      dialog=await waitForDialog();
    }
    if(!dialog) {
      send({scanning:false,done:true,error:"WhatsApp did not open the Search members window. Click View all manually and try again.",title:"Participant list not opened."});
      return;
    }

    const scroller=findDialogScroller(dialog);
    const found=new Map();
    if(!scroller) {
      collectDialog(dialog,found);
      latestRows=[...found.values()];
      send({scanning:false,done:true,progress:100,scanned:found.size,contactCount:found.size,
        title:"Extraction completed",note:"Only the visible entries in Search members could be read."});
      return;
    }

    scroller.scrollTop=0;
    await sleep(250);
    collectDialog(dialog,found);
    send({title:"Scanning participants…",note:"Scanning only inside the Search members window."});

    let steps=0,atBottomStable=0,lastHeight=scroller.scrollHeight,lastCount=-1;
    for(;steps<350;steps++) {
      if(!dialog.isConnected||!scroller.isConnected||!dialog.contains(scroller)) break;
      const before=scroller.scrollTop;
      scroller.scrollTop=Math.min(before+Math.max(160,Math.floor(scroller.clientHeight*.68)),scroller.scrollHeight);
      await sleep(300);
      collectDialog(dialog,found);

      const atBottom=scroller.scrollTop+scroller.clientHeight>=scroller.scrollHeight-5;
      if(atBottom) {
        await sleep(350);
        collectDialog(dialog,found);
        if(scroller.scrollHeight===lastHeight && found.size===lastCount) atBottomStable++;
        else atBottomStable=0;
      } else atBottomStable=0;

      lastHeight=scroller.scrollHeight;
      lastCount=found.size;
      const progress=memberCount ? Math.min(98,(steps+1)/(Math.max(1,Math.ceil(memberCount/6)))*100) : Math.min(95,steps/80*100);
      send({progress,scanned:found.size,contactCount:found.size,
        note:`Collected ${found.size} unique phone number(s) so far.`});
      if(atBottomStable>=5 || (scroller.scrollTop===before&&atBottom)) break;
    }

    collectDialog(dialog,found);
    latestRows=[...found.values()].sort((a,b)=>a.name.localeCompare(b.name)||a.phone.localeCompare(b.phone));
    send({scanning:false,done:true,progress:100,scanned:latestRows.length,contactCount:latestRows.length,
      title:"Extraction completed",note:`${latestRows.length} unique phone number(s) ready to export.`});
  }

  chrome.runtime.onMessage.addListener((msg,sender,sendResponse)=>{
    if(msg?.type==="TEJO_START_SCAN") {
      if(scanPromise) {
        sendResponse({ok:false,message:"A scan is already running."});
        return;
      }
      scanPromise=runScan().catch(err=>{
        console.error("TejoERP WhatsApp extractor",err);
        send({scanning:false,done:true,error:"The scan stopped unexpectedly. Refresh WhatsApp Web and try again.",title:"Scan interrupted."});
      }).finally(()=>{scanPromise=null;});
      sendResponse({ok:true});
      return true;
    }
    if(msg?.type==="TEJO_EXPORT_CSV") {
      const ok=downloadCsv();
      sendResponse(ok?{ok:true}:{ok:false,message:"No completed extraction is available on this WhatsApp tab."});
      return true;
    }
    if(msg?.type==="TEJO_GET_STATUS") {
      sendResponse({ok:true,data:latestStatus,groupName:latestStatus.groupName||getGroupName(),memberCount:latestStatus.memberCount??getMemberCount()});
      return true;
    }
  });
})();