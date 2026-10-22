import test from 'node:test';
import assert from 'node:assert/strict';
import { audienceTarget, audienceKey, freshAudienceRecord, audienceRequestTarget, mergeAudienceCoverage } from '../src/lib/useAudienceHistory.js';
import { audienceStatusText } from '../src/lib/audience-status.js';

test('automatic audience targets distinguish a track discovery from an artist discovery and reuse a resolved artist ID',()=>{
  const track=audienceTarget({id:'track',name:'A song',artist:'RAC',firstPlayed:'2024-01-15T00:00:00.000Z'});
  const artist=audienceTarget({id:'artist:rac',name:'RAC',artist:'RAC',firstPlayed:'2019-01-01T00:00:00.000Z'});
  assert.equal(track.name,'RAC');assert.equal(artist.name,'RAC');assert.notEqual(audienceKey(track),audienceKey(artist));
  assert.equal(audienceKey(track),audienceKey({...track,name:'rac',artistId:'resolved-id'}));
  assert.equal(audienceTarget({name:'RAC',firstPlayed:'invalid'}),null);
});

test('coverage caching respects successful daily checks and temporary provider backoff',()=>{
  const now=100000000;
  assert.equal(freshAudienceRecord({checkedAt:now-1000,status:'not_tracked'},now),true);
  assert.equal(freshAudienceRecord({checkedAt:now-86400001,status:'ready'},now),false);
  assert.equal(freshAudienceRecord({checkedAt:now-59000,retryable:true,retryAfterSeconds:60},now),true);
  assert.equal(freshAudienceRecord({checkedAt:now-61000,retryable:true,retryAfterSeconds:60},now),false);
});

test('portable audience progress sends only capture identities and merges incremental verified observations',()=>{
  const target={name:'Artist',artistId:'123',firstPlayed:'2024-01-15T00:00:00.000Z'};
  const snapshot=(date,listeners,extra={})=>({artist:'Artist',artistId:'123',date,listeners,source:'Kworb',metric:'monthly_listeners',...extra});
  const first=mergeAudienceCoverage(null,{status:'deferred',retryable:true,archiveChecked:['0:20240101000000'],hasBaseline:true},target,[snapshot('2024-01-01T00:00:00Z',13),snapshot('2026-01-01T00:00:00Z',2000000)]);
  assert.equal(first.hasBaseline,true);
  assert.equal(first.status,'deferred','a usable baseline does not stop unfinished archive work');
  assert.deepEqual(audienceRequestTarget(target,first),{...target,archiveChecked:['0:20240101000000']});
  assert.ok(!('observations' in audienceRequestTarget(target,first)), 'observations and listener counts never return to the server');
  const finished=mergeAudienceCoverage(first,{status:'no_baseline',retryable:false,archiveChecked:['0:20240101000000','1:20240101000000'],hasBaseline:false},target,[snapshot('2026-01-01T00:00:00Z',2000000),snapshot('2024-02-01T00:00:00Z',100),snapshot('2024-01-10T00:00:00Z',999,{artist:'Another artist'}),snapshot('2024-01-10T00:00:00Z',999,{artistId:'another-id'})]);
  assert.equal(finished.hasBaseline,true,'cold responses do not erase a prior verified baseline');
  assert.equal(finished.status,'ready');
  assert.equal(finished.count,3);
  assert.equal(finished.baselineDate,'2024-01-01T00:00:00.000Z');
  assert.equal(finished.observations.length,3);
  const forged=mergeAudienceCoverage(null,{status:'no_baseline',archiveChecked:['0:20240101000000'],hasBaseline:false},target,[]);
  assert.equal(forged.hasBaseline,false);
  assert.equal(forged.observations.length,0);
  assert.deepEqual(audienceRequestTarget(target,{archiveChecked:['https://example.com','0:20240101000000','0:20240101000000']}),{...target,archiveChecked:['0:20240101000000']});
});

test('unknown or unavailable Spotify listener history is explained without requesting manual CSV input',()=>{
  for(const status of ['ready','no_baseline','not_tracked','unavailable','deferred','ambiguous']){
    const explanation=audienceStatusText({status});assert.ok(explanation.length>15);assert.doesNotMatch(explanation,/CSV|введите|загрузите|добавьте/i);
  }
  assert.match(audienceStatusText({status:'unavailable'}),/автоматически/);
  assert.equal(audienceStatusText({status:'not_tracked',note:'Исполнитель не найден в доступных таблицах Kworb. Исторические значения неизвестны.'}),'Исполнитель не найден в доступных таблицах');
});
