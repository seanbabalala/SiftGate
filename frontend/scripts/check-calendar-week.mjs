import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
export async function checkCalendarWeek({ root, moduleFrom, usageForm, hashing }) {
  const time = moduleFrom(path.join(root,'../src/pricing/pricing-time.ts'))
  const dates = moduleFrom(path.join(root,'../src/pricing/pricing-week-dates.ts'),{'./pricing-time':time})
  const model = moduleFrom(path.join(root,'src/lib/calendar-week.ts'),{'./usage-recovery-form':usageForm,'../../../src/pricing/pricing-time':time,'../../../src/pricing/pricing-week-dates':dates})
  const calendar={schema_version:1,version_id:'synthetic-calendar',time_zone:'Asia/Shanghai',tzdb_version:'synthetic',valid_from:'2026-01-01',valid_to:'2027-01-01',default_tag:'offpeak',weekly:[],holidays:[],date_overrides:[]},date='2026-09-30';
  const days=model.pricingWeekDates(date).map(date=>({date,covered:true,segments:[{start:'00:00',end:'24:00',tag:'offpeak',source:'fallback',anchor_date:date}]}))
  const base={schema_version:1,simulation:true,read_only:true,complete:true,interpretation:'civil_schedule_not_elapsed_time',requested_date:date,week_start:days[0].date,input_hash:hashing.pricingContentHash({calendar,date}),calendar:{version_id:calendar.version_id,content_hash:'a'.repeat(64),time_zone:calendar.time_zone,tzdb_version:calendar.tzdb_version,valid_from:calendar.valid_from,valid_to:calendar.valid_to,holiday_version:null},days}
  const seal=value=>({...value,evidence_hash:hashing.pricingContentHash(value)})
  await model.verifyCalendarWeek(seal(base),calendar,date)
  const patches=[{complete:false},{read_only:false},{week_start:'2026-09-29'},{input_hash:'0'.repeat(64)},{interpretation:'elapsed_billable_time'},{days:days.slice(1)},{calendar:{...base.calendar,version_id:'current'}},{calendar:{...base.calendar,time_zone:'America/New_York'}},{calendar:{...base.calendar,tzdb_version:'other'}}]
  for(const patch of patches)await assert.rejects(model.verifyCalendarWeek(seal({...base,...patch}),calendar,date))
  for(const bad of [{start:'01:00'}, {end:'23:59'}, {end:'00:00'}, {source:'guessed'}, {anchor_date:'2026-01-01'},{start:'24:00'}]) {
    const changed=structuredClone(days);Object.assign(changed[0].segments[0],bad);await assert.rejects(model.verifyCalendarWeek(seal({...base,days:changed}),calendar,date))
  }
  const gap=structuredClone(days);gap[0].segments=[{start:'00:00',end:'01:00',tag:'a',source:'weekly',anchor_date:days[0].date},{start:'02:00',end:'24:00',tag:'b',source:'weekly',anchor_date:days[0].date}];await assert.rejects(model.verifyCalendarWeek(seal({...base,days:gap}),calendar,date))
  const uncovered={...calendar,valid_from:'2026-09-30',valid_to:'2026-10-02'},partial=structuredClone(base);partial.calendar={...partial.calendar,valid_from:uncovered.valid_from,valid_to:uncovered.valid_to};partial.input_hash=hashing.pricingContentHash({calendar:uncovered,date});partial.days=days.map(day=>day.date>=uncovered.valid_from&&day.date<uncovered.valid_to?day:{...day,covered:false,segments:[]});await model.verifyCalendarWeek(seal(partial),uncovered,date)
  await assert.rejects(model.verifyCalendarWeek({...seal(base),evidence_hash:'0'.repeat(64)},calendar,date));assert.equal(model.CALENDAR_SEGMENTS_PER_PAGE,12)
  for(const locale of ['en','zh','zh-TW','ja','ko','th','es']) {assert.equal(model.calendarDateLabel(date,locale),new Date(date+'T00:00:00Z').toLocaleDateString(locale,{timeZone:'UTC',weekday:'short',year:'numeric',month:'short',day:'numeric'}));const t=JSON.parse(fs.readFileSync(path.join(root,`src/locales/${locale}/pricing.json`)));for(const key of ['title','help','date','run','cancel','invalidDate','failed','stale','civil','ready','uncovered','details','rows','anchor','carry',...model.CALENDAR_SOURCES.map(s=>'source.'+s)])assert.ok(t['calendarWeek.'+key])}
  const ui=fs.readFileSync(path.join(root,'src/components/pricing/calendar-week-preview.tsx'),'utf8');for(const text of ['active.current?.abort()','verifyCalendarWeek(value, calendar, date)','result?.signature === signature','CALENDAR_SEGMENTS_PER_PAGE','15000'])assert.ok(ui.includes(text));assert.ok(!ui.includes('onChange={onChange}'))
  const editor=fs.readFileSync(path.join(root,'src/components/pricing/price-book-editor.tsx'),'utf8');assert.ok(editor.includes('import(\'./calendar-week-preview\')'));assert.ok(editor.indexOf('<CalendarWeekPreview ')>editor.indexOf('</fieldset>'),'Read-only preview must remain accessible for published/viewer documents')
  console.log('Calendar week contracts passed: seven civil dates, bound input/version/hash/zone, contiguous segments, uncovered dates, locale, stale/cancel and bounded detail pages.')
}
