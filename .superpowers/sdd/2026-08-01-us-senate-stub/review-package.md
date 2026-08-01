# Review package — us-senate not-yet-published guard (144b3204fa3c97679d740a1f55541acd68de5688..HEAD)

31dc3b3 fix: us-senate ingest — not-yet-published vote crashed the run instead of counting as an expected miss

## Stat
 src/adapters/us-senate.js                          |  47 ++
 .../fixtures/us-senate/roll-call-unavailable.html  | 580 +++++++++++++++++++++
 tests/us-senate.test.js                            |  73 ++-
 3 files changed, 699 insertions(+), 1 deletion(-)

## Full diff (-U10)
diff --git a/src/adapters/us-senate.js b/src/adapters/us-senate.js
index 7542621..0afb237 100644
--- a/src/adapters/us-senate.js
+++ b/src/adapters/us-senate.js
@@ -1,13 +1,14 @@
 import { XMLParser } from 'fast-xml-parser';
 import { fetchWithLimit } from '../lib/http.js';
 import { createLimiter } from '../lib/rate-limiter.js';
+import { SourceFetchError } from '../lib/errors.js';
 import { normalizeBillIdentifier } from './us-congress.js';
 
 export const SOURCE = 'us-senate';
 // senate.gov LIS XML needs no auth/key; be polite anyway (PLAYBOOK §3.2 - shared limiter).
 export const senateLimiter = createLimiter({ minIntervalMs: 1000 });
 
 const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
 
 const SENATE_POSITION_MAP = new Map([
   ['yea', 'yea'], ['guilty', 'yea'],
@@ -68,23 +69,69 @@ export function parseSenateVoteMenu(xmlString) {
   if (!Array.isArray(votes)) votes = [votes];
   return votes.map((v) => ({
     vote_number: Number(v.vote_number),
     date: parseMenuDate(v.vote_date, year),
     question: textOf(v.question),
     result: textOf(v.result),
     issue: textOf(v.issue),
   }));
 }
 
+// Thrown by parseSenateRollCall for a not-yet-cast vote number. Extends SourceFetchError (not a
+// bare Error, unlike uscode.js's UscSectionNotFoundError) so it flows through collectUsSenate's
+// existing `if (!(err instanceof SourceFetchError)) throw err;` per-vote catch unchanged - same
+// expected-miss handling us-congress already gets for a real HTTP 404 on a tail roll number.
+export class RollCallNotYetPublishedError extends SourceFetchError {
+  constructor(message, meta = {}) {
+    super(message, meta);
+    this.name = 'RollCallNotYetPublishedError';
+  }
+}
+
+// Verified live 2026-08-01 against real senate.gov (session 119-2, vote numbers 220/250/999 -
+// all three byte-identical: one generic template, not per-vote content; see tests/fixtures/
+// us-senate/roll-call-unavailable.html for the captured body). A not-yet-cast/not-yet-published
+// roll call number is HTTP 200 (NOT a 404 - fetchWithLimit's !res.ok check never fires) with an
+// HTML page instead of roll-call XML: <title>U.S. Senate: Roll Call Vote Unavailable</title>,
+// <h1>Roll Call Vote Unavailable</h1>, body text "Results of roll call votes are published
+// approximately an hour after they have been announced." fast-xml-parser is lenient and does not
+// throw on this (confirmed empirically against this exact payload plus several other malformed
+// inputs - it never throws with this module's parser config); it silently parses the HTML into a
+// tree with no roll_call_vote key at all, which used to surface downstream as
+// `TypeError: Cannot read properties of undefined (reading 'congress')` the moment root.congress
+// was read - a crash, not a classified miss, on every hourly scheduler probe during a recess.
+const ROLL_CALL_UNAVAILABLE_MARKER = 'Roll Call Vote Unavailable';
+
 export function parseSenateRollCall(xmlString) {
   const doc = xmlParser.parse(xmlString);
   const root = doc.roll_call_vote;
+  if (!root) {
+    // Distinguish the known "not yet published" stub (expected miss - honestly counted, run
+    // stays healthy-partial) from any other reason the root might be missing (truncated
+    // transfer, senate.gov template change, genuine corruption on what should be a real,
+    // existing vote) - the latter must still fail loudly, never silently reclassified as a
+    // routine miss. Only the recognized stub shape gets the typed SourceFetchError-style error;
+    // anything else falls through to a plain thrown Error below.
+    if (String(xmlString).includes(ROLL_CALL_UNAVAILABLE_MARKER)) {
+      throw new RollCallNotYetPublishedError(
+        'senate.gov has no roll call at this vote number yet (LIS returns HTTP 200 with an HTML '
+        + '"Roll Call Vote Unavailable" stub, not a 404, for a not-yet-cast vote) - expected miss, '
+        + 'not a parse bug',
+        { source: SOURCE },
+      );
+    }
+    throw new Error(
+      'parseSenateRollCall: response has no <roll_call_vote> root and does not match the known '
+      + '"Roll Call Vote Unavailable" not-yet-published stub either - genuine parse failure, not '
+      + `an expected miss (first 200 chars: ${JSON.stringify(String(xmlString).slice(0, 200))})`,
+    );
+  }
   const congress = Number(root.congress);
   const session = Number(root.session);
   const number = Number(root.vote_number);
   const billName = root.document?.document_name;
   let members = root.members?.member ?? [];
   if (!Array.isArray(members)) members = [members];
   return {
     vote: {
       source_key: `us-senate-${congress}-${session}-${number}`,
       chamber: 'senate',
diff --git a/tests/fixtures/us-senate/roll-call-unavailable.html b/tests/fixtures/us-senate/roll-call-unavailable.html
new file mode 100644
index 0000000..fbd0171
--- /dev/null
+++ b/tests/fixtures/us-senate/roll-call-unavailable.html
@@ -0,0 +1,580 @@
+<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
+<!-- [if lt IE 7]> <html class="ie6 oldie"> <![endif] --><!-- [if IE 7]>    <html class="ie7 oldie"> <![endif] --><!-- [if IE 8]>    <html class="ie8 oldie"> <![endif] --><!-- [if gt IE 8]> <! --><html class="">
+<!-- <![endif] -->
+<head>
+<META http-equiv="Content-Type" content="text/html; charset=iso-8859-1">
+<meta charset="UTF-8">
+<meta name="viewport" content="width=device-width, initial-scale=1">
+<meta name="object" content="roll-call-vote-not-available.xml">
+<meta name="version" content="3.1">
+<meta name="path" content="/Company Home/Sites/senategov/documentLibrary/Senate.gov/legislative">
+<meta name="date" content="Wednesday, August 9, 2023">
+<meta name="time" content="10:29:51 AM EDT">
+<meta name="keywords" content="">
+<meta name="bucket" content="legislative">
+<meta name="description" content="">
+<title>U.S. Senate: Roll Call Vote Unavailable</title>
+<link type="image/x-icon" rel="shortcut icon" href="/resources/images/us_sen.ico">
+<link type="text/css" rel="stylesheet" href="/resources/styles/boilerplate.css">
+<link type="text/css" rel="stylesheet" href="/resources/styles/main.css">
+<link type="text/css" rel="stylesheet" href="/resources/styles/nav_menu.css">
+<link type="text/css" rel="stylesheet" href="/resources/styles/skdslider.css">
+<link type="text/css" rel="stylesheet" href="/resources/fonts/gFonts.css?family=Source+Sans+Pro:400,300,600,700,300italic,400italic,600italic,700italic">
+<link type="text/css" rel="stylesheet" href="/resources/fonts/gFonts.css?family=Source+Serif+Pro:400,600,700">
+<link type="text/css" rel="stylesheet" href="/resources/fonts/gFonts.css?family=Libre+Baskerville:400,400italic,700">
+<link rel="stylesheet" href="/resources/fonts/css/font-awesome.min.css">
+<link type="text/css" rel="stylesheet" href="/resources/styles/print.css">
+<link type="text/css" rel="stylesheet" href="/resources/styles/content.css">
+<!-- [if lt IE 9]> <script src="/resources/scripts/html5shiv.js"></script> <![endif] --> 
+  
+<script type="text/javascript">
+
+function MM_goToURL() { //v3.0
+  var i, args=MM_goToURL.arguments; document.MM_returnValue = false;
+  for (i=0; i<(args.length-1); i+=2) eval(args[i]+".location='"+args[i+1]+"'");
+}
+
+</script>
+    <script type="text/javascript">
+function MM_jumpMenu(targ,selObj,restore){ //v3.0
+  eval(targ+".location='"+selObj.options[selObj.selectedIndex].value+"'");
+  if (restore) selObj.selectedIndex=0;
+}
+</script><script src="/resources/scripts/jquery-1.11.3.min.js"></script><script src="/resources/scripts/skdslider.min.js"></script><script src="/resources/scripts/main.js"></script><script src="/resources/scripts/floor_status.js"></script>
+</head>
+<body onload="myFunction()">
+<a href="#skip" class="offscreen">Skip Content</a>
+<header class="mobilehead clearfix">
+<div id="top-header">
+<CFPARAM NAME="URL.q" DEFAULT="">
+        <div id="find-sen" class="row">
+          <div id="flag" class="fluid "><img src="/resources/images/usFlag.png" alt="U.S. Flag" /></div>
+          <div id="sen-dropdown-container" class="fluid ">
+          <form name="findSenators" method="post">
+            <label for="findsenator" />
+            <select name="stateName" class="arrow" id="findsenator" onChange="MM_jumpMenu('parent',this,0)">
+              <option value="/states/">Find Your Senators</option>
+              <option value="/states/AL/intro.htm">Alabama</option>
+              <option value="/states/AK/intro.htm">Alaska</option>
+              <option value="/states/AZ/intro.htm">Arizona</option>
+              <option value="/states/AR/intro.htm">Arkansas</option>
+              <option value="/states/CA/intro.htm">California</option>
+              <option value="/states/CO/intro.htm">Colorado</option>
+              <option value="/states/CT/intro.htm">Connecticut</option>
+              <option value="/states/DE/intro.htm">Delaware</option>
+              <option value="/states/FL/intro.htm">Florida</option>
+              <option value="/states/GA/intro.htm">Georgia</option>
+              <option value="/states/HI/intro.htm">Hawaii</option>
+              <option value="/states/ID/intro.htm">Idaho</option>
+              <option value="/states/IL/intro.htm">Illinois</option>
+              <option value="/states/IN/intro.htm">Indiana</option>
+              <option value="/states/IA/intro.htm">Iowa</option>
+              <option value="/states/KS/intro.htm">Kansas</option>
+              <option value="/states/KY/intro.htm">Kentucky</option>
+              <option value="/states/LA/intro.htm">Louisiana</option>
+              <option value="/states/ME/intro.htm">Maine</option>
+              <option value="/states/MD/intro.htm">Maryland</option>
+              <option value="/states/MA/intro.htm">Massachusetts</option>
+              <option value="/states/MI/intro.htm">Michigan</option>
+              <option value="/states/MN/intro.htm">Minnesota</option>
+              <option value="/states/MS/intro.htm">Mississippi</option>
+              <option value="/states/MO/intro.htm">Missouri</option>
+              <option value="/states/MT/intro.htm">Montana</option>
+              <option value="/states/NE/intro.htm">Nebraska</option>
+              <option value="/states/NV/intro.htm">Nevada</option>
+              <option value="/states/NH/intro.htm">New Hampshire</option>
+              <option value="/states/NJ/intro.htm">New Jersey</option>
+              <option value="/states/NM/intro.htm">New Mexico</option>
+              <option value="/states/NY/intro.htm">New York</option>
+              <option value="/states/NC/intro.htm">North Carolina</option>
+              <option value="/states/ND/intro.htm">North Dakota</option>
+              <option value="/states/OH/intro.htm">Ohio</option>
+              <option value="/states/OK/intro.htm">Oklahoma</option>
+              <option value="/states/OR/intro.htm">Oregon</option>
+              <option value="/states/PA/intro.htm">Pennsylvania</option>
+              <option value="/states/RI/intro.htm">Rhode Island</option>
+              <option value="/states/SC/intro.htm">South Carolina</option>
+              <option value="/states/SD/intro.htm">South Dakota</option>
+              <option value="/states/TN/intro.htm">Tennessee</option>
+              <option value="/states/TX/intro.htm">Texas</option>
+              <option value="/states/UT/intro.htm">Utah</option>
+              <option value="/states/VT/intro.htm">Vermont</option>
+              <option value="/states/VA/intro.htm">Virginia</option>
+              <option value="/states/WA/intro.htm">Washington</option>
+              <option value="/states/WV/intro.htm">West Virginia</option>
+              <option value="/states/WI/intro.htm">Wisconsin</option>
+              <option value="/states/WY/intro.htm">Wyoming</option>
+            </select>
+          </form>
+        </div>
+          <div id="watch" class="fluid">
+			<div class="fluid watch_text"><span class="fa fa-video-camera"></span>&nbsp;&nbsp;<a id="floorlink" target="_blank"><span id="contentdata"></span></a></div>
+          </div>
+          </div>
+        </div>
+      </div>
+	  
+	  <div id="main-header">
+<div class="row">
+
+<div id="logo">
+	<a href="/index.htm"><img src="/resources/images/senate_logo.png" alt="United States Senate Logo" border="0"/></a>
+</div>
+
+ <div id="search-elements" class="fluid "> 
+	<form name="search" id="search" action="/general/search/search_central_solr-js.htm" method="GET">
+          <label for="search"><span class="fa fa-search" onClick="document.getElementById('search').submit();"></span></label>
+          <input type="text" name="q" value="Search" id="search3" onfocus="this.value=''" />
+          <!--commented out by betty<input type="hidden" value="1" name="col" /> 
+          <INPUT type="hidden" name="xsl" value="xml" />-->
+	  <!--<input type="text" name="q" value="Search" id="search" onfocus="this.value=''" />
+	  <input type="hidden" name="site" value="default_collection" />
+	  <input type="hidden" name="num" value="10" />
+	  <INPUT type="hidden" name="filter" value="0" />-->
+	</form>
+
+
+     <!--solr search section starts
+     <form method="GET" action="/general/search/search_central_solr.cfm" name="search" style="display: inline;">
+        <input type="text" onFocus="this.value=&apos;&apos;" class="searchBox" id="search3" value="<CFOUTPUT>#URL.q#</CFOUTPUT>" name="q"/>
+		<input type="image" align="absmiddle" alt="GO" src="/resources/images/uss_button_go.gif"/>
+	 </form>
+     solr search section ends-->
+  </div>
+
+</div>
+</div>
+
+<div class="nav">
+<div id="nav-head-bg"></div>
+<div class="row">
+<nav id="main-nav" class="fluid ">
+<label for="drop" class="toggle">MENU<span class="fa fa-bars"></span></label><input type="checkbox" id="drop">
+<ul class="menu">
+<li class="senatorsmenu">
+<label for="drop-1" class="plus-minus mobile-plus"></label><a href="/senators/index.htm">
+<div>SENATORS</div>
+</a>
+<input type="checkbox" id="drop-1"/>
+  <ul class="senatorsmenusub">
+	<li><a href="/senators/senators-contact.htm">Contact Your Senators</a></li>
+        <li><a href="/senators/leadership.htm">Leadership &amp; Officers</a></li>
+        <li><a href="/senators/former_senators.htm">Former Senators</a></li>
+        <li><a href="/senators/qualifications_termsofservice.htm">Qualifications &amp; Terms of Service</a></li>
+        <li><a href="/senators/facts_milestones.htm">Facts &amp; Milestones</a></li>
+	  
+          <li><a href="/states/statesmap.htm">States in the Senate</a></li>
+  </ul>
+</li>
+<li class="committeesmenu">
+<label for="drop-2" class="plus-minus mobile-plus"></label><a href="/committees/committees_home.htm">
+<div>COMMITTEES</div>
+</a>
+<input type="checkbox" id="drop-2"/>
+  <ul class="committeesmenusub">
+	<li><a href="/committees/membership_assignments.htm">Membership &amp; Assignments </a></li>
+	  <li><a href="/committees/hearings_meetings.htm">Hearings &amp; Meetings</a></li>
+	  <li><a href="/committees/history.htm">History</a></li>
+  </ul>
+</li>
+<li class="legislationmenu">
+<label for="drop-3" class="plus-minus mobile-plus"></label><a href="/legislative/legislative_home.htm" class="selected">
+<div>LEGISLATION &amp; RECORDS</div>
+</a>
+<input type="checkbox" id="drop-3"/>
+	<ul class="legislationmenusub">
+		<li><a href="/legislative/bills_acts_laws.htm">Bills, Acts, &amp; Laws</a></li>
+	  <li><a href="/legislative/nominations_new.htm">Nominations</a></li>
+	  <li><a href="/legislative/treaties_new.htm">Treaties</a></li>
+	  <li><a href="/legislative/votes_new.htm">Votes</a></li>
+          <li><a href="/legislative/floor_activity_pail.htm">Floor Proceedings</a></li>
+	  <li><a href="/legislative/rules_procedure.htm">Rules &amp; Procedure</a></li>
+	  <li><a href="/legislative/landmark_legislation.htm">Landmark Legislation</a></li>
+	  <li><a href="/legislative/sessions_of_congress.htm">Sessions of Congress</a></li>
+          <li><a href="/legislative/senate-archives/information-about-senate-archives.htm">Senate Archives</a></li>
+	 
+	  <li><a href="/legislative/lobbyingdisc.htm#lobbyingdisc=lda">Public Disclosure</a></li>
+	  </ul>
+</li>
+<li class="artartifactsmenu">
+<label for="drop-4" class="plus-minus mobile-plus"></label><a href="/art-artifacts/index.htm">
+<div>ART &amp; ARTIFACTS</div>
+</a>
+<input type="checkbox" id="drop-4"/>
+
+  <ul class="artartifactsmenusub">
+  <li><a href="/general/search/search-art-artifacts-solr-js.htm">Collection Search</a></li>
+ <li><a href="/art-artifacts/fine-art-landing-page.htm">Fine Art</a></li>
+	<li><a href="/art-artifacts/decorative-art-landing-page.htm">Decorative Art</a></li>
+       <li><a href="/art-artifacts/historical-images-landing-page.htm">Historical Images</a></li>
+        <li><a href="/art-artifacts/historical-artifacts-landing-page.htm">Historical Artifacts</a></li>
+        
+        <li><a href="/art-artifacts/thematic-collections-landing-page.htm">Thematic Collections</a></li>
+        <li><a href="/art-artifacts/exhibitions-publications-landing-page.htm">Exhibitions &amp; Publications</a></li>
+	  
+  </ul>
+
+</li>
+<li class="aboutmenu">
+<label for="drop-5" class="plus-minus mobile-plus"></label><a href="/about/index.htm">
+<div>ABOUT THE SENATE</div>
+</a>
+<input type="checkbox" id="drop-5"/>
+
+<ul class="aboutmenusub">
+        	<li>
+            <label for="drop-44" class="plus-minus mobile-plus"> </label>
+                  <a class="drop-link" href="/about/officers-staff.htm">Officers &amp; Staff</a>
+                  <input type="checkbox" id="drop-44"/>
+                  <ul class="tertiary-menu">
+                  	<li><a href="/about/officers-staff/vice-president.htm">Vice President</a></li>
+        			<li><a href="/about/officers-staff/president-pro-tempore.htm">President Pro Tempore</a></li>
+        			<li><a href="/about/officers-staff/secretary-of-the-senate.htm">Secretary of the Senate</a></li>
+        			<li><a href="/about/officers-staff/sergeant-at-arms.htm">Sergeant at Arms</a></li>
+                                <li><a href="/about/officers-staff/party-secretaries.htm">Party Secretaries</a></li>
+
+                                <li><a href="/about/officers-staff/chaplain.htm">Chaplain</a></li>
+
+                                <li><a href="/about/officers-staff/committee-office-staff.htm">Committee &amp; Office Staff</a></li>
+
+                                <li><a href="/about/officers-staff/pages.htm">Pages</a></li>
+                  </ul>
+            
+            </li>
+            <li> 
+                  <label for="drop-45" class="plus-minus mobile-plus"> </label>
+                  <a class="drop-link" href="/about/powers-procedures.htm">Powers &amp; Procedures</a>
+                  <input type="checkbox" id="drop-45"/>
+                  	<ul class="tertiary-menu">
+                    <li><a href="/about/powers-procedures/censure.htm">Censure</a></li>
+                    <li><a href="/about/powers-procedures/declarations-of-war.htm">Declarations of War</a></li>
+                    <li><a href="/about/powers-procedures/expulsion.htm">Expulsion</a></li>
+                    <li><a href="/about/powers-procedures/filibusters-cloture.htm">Filibuster &amp; Cloture</a></li>
+                    <li><a href="/about/powers-procedures/impeachment.htm">Impeachment</a></li>
+<li><a href="/about/powers-procedures/investigations.htm">Investigations</a></li>
+<li><a href="/about/powers-procedures/nominations.htm">Nominations</a></li>
+<li><a href="/about/powers-procedures/rules.htm">Rules</a></li>
+<li><a href="/about/powers-procedures/treaties.htm">Treaties</a></li>
+<li><a href="/about/powers-procedures/voting.htm">Voting</a></li>
+                  	</ul>
+                    
+            </li>
+    <li>
+	 <label for="drop-46" class="plus-minus mobile-plus"> </label>
+	<a class="drop-link" href="/about/origins-foundations.htm">Origins &amp; Foundations</a>
+                  <input type="checkbox" id="drop-46"/>
+                  	<ul class="tertiary-menu">
+                    	<li><a href="/about/origins-foundations/senate-and-constitution.htm">The Senate &amp; the Constitution</a></li>
+        				<li><a href="/about/origins-foundations/electing-appointing-senators.htm">Electing &amp; Appointing Senators</a></li>
+        				<li><a href="/about/origins-foundations/committee-system.htm">Committee System</a></li>
+        				<li><a href="/about/origins-foundations/idea-of-the-senate.htm">Idea of the Senate</a></li>
+        				<li><a href="/about/origins-foundations/parties-leadership.htm">Parties &amp; Leadership</a></li>
+
+                    </ul>
+            </li>
+  <li><a class="drop-link" href="/about/parties-leadership.htm">Parties &amp; Leadership</a></li>
+            
+	     <li> 
+
+         
+                  <label for="drop-47" class="plus-minus mobile-plus"> </label>
+                  <a class="drop-link" href="/about/historic-buildings-spaces.htm">Historic Buildings &amp; Spaces</a>
+                  <input type="checkbox" id="drop-47"/>
+                  	<ul class="tertiary-menu">
+                    <li><a href="/about/historic-buildings-spaces/capitol.htm">The Capitol</a></li>
+                    <li><a href="/about/historic-buildings-spaces/senate-chamber.htm">Senate Chamber</a></li>
+                    <li><a href="/about/historic-buildings-spaces/historic-rooms.htm">Historic Rooms</a></li>
+<li><a href="/about/historic-buildings-spaces/office-buildings.htm">Senate Office Buildings</a></li>
+<li><a href="/about/historic-buildings-spaces/meeting-places.htm">Congressional Meeting Places</a></li>
+<li><a href="/about/historic-buildings-spaces/past-chambers.htm">Past Senate Chambers</a></li>
+                  	</ul>
+                    
+            </li>
+<li><a class="drop-link" href="/about/traditions-symbols.htm">Traditions &amp; Symbols</a></li>
+          	<li><a class="drop-link" href="/history/oralhistory.htm">Oral History Project</a></li>
+          <li> 
+                  <label for="drop-48" class="plus-minus mobile-plus"> </label>
+                  <a class="drop-link" href="/history/essays.htm">Historical Highlights</a>
+                  <input type="checkbox" id="drop-48"/>
+                  	<ul class="tertiary-menu">
+                    <li><a href="/history/1787.htm">1787-1800</a></li>
+                    <li><a href="/history/1801.htm">1801-1850</a></li>
+                    <li><a href="/history/1851.htm">1851-1877</a></li>
+                    <li><a href="/history/1878.htm">1878-1920</a></li>
+                    <li><a href="/history/1921.htm">1921-1940</a></li>
+ <li><a href="/history/1941.htm">1941-1963</a></li>
+ <li><a href="/history/1964.htm">1964-present</a></li>
+
+                  	</ul>
+                    
+            </li>
+<li><a class="drop-link" href="/artandhistory/senate-stories/menu.htm">Senate Stories Blog</a></li>
+          <li> 
+      	<li><a class="drop-link" href="/about/research-tools.htm">Research Tools</a></li>
+          <li> 
+</ul>
+
+
+
+    	
+
+</li>
+</ul>
+</nav>
+</div>
+</div>
+</header>
+<div id="watch_mobile" class="fluid  watch_text"><span class="fa fa-video-camera"></span>&nbsp;&nbsp;<a id="floorlink_mobile" target="_blank"><span id="contentdata_mobile"></span></a></div>
+<main class="gridContainer clearfix">
+<div id="secondary_col2" class="fluid">
+<section class="fluid " id="legislative_header">
+<h1>Roll Call Vote Unavailable</h1>
+<div id="h1_action_icons" class="fluid"><a href="javascript:if(window.print)window.print()"><i class="fa fa-print"></i></a>
+    <!--<a href="index.html"><i class="fa fa-share"></i></a>-->
+</div>
+<hr class="fluid">
+</section>
+<!--
+      BEGIN MAIN
+    -->
+<span tabindex="-1" id="skip"></span>
+<style>
+    .more {
+	display: none;
+	/*
+    border-top: 1px solid #666;
+	border-bottom: 1px solid #666;
+*/
+     }
+  .more {
+	display: none;
+	/*
+    border-top: 1px solid #666;
+	border-bottom: 1px solid #666;
+*/
+     }
+a.itemLink {
+    text-decoration: none;
+	color: #7496af;
+    }
+a.itemLink:hover {
+    text-decoration: underline;
+    }
+a.showLink, a.hideLink {
+	text-decoration: none;
+	color: #7496af;
+	padding-left: 3px;
+	background: transparent url('down.gif') no-repeat left; }
+a.hideLink {
+	background: transparent url('up.gif') no-repeat left; }
+a.showLink:hover, a.hideLink:hover {
+	border-bottom: 1px dotted #5B85C9; }
+</style>
+<script>
+function showHide(shID) {
+   if (document.getElementById(shID)) {
+      if (document.getElementById(shID+'-show').style.display != 'none') {
+         document.getElementById(shID+'-show').style.display = 'none';
+         document.getElementById(shID+'-hide').style.display = 'inline';
+         document.getElementById(shID).style.display = 'block';
+      }
+      else {
+         document.getElementById(shID+'-show').style.display = 'inline';
+         document.getElementById(shID+'-hide').style.display = 'none';
+         document.getElementById(shID).style.display = 'none';
+      }
+   }
+}
+</script>
+<div class="contenttext_generic">
+<full_story>
+<P>Results of roll call votes are published approximately an hour after they have been announced.</P>
+<P>Return to the <a href="/legislative/votes_new.htm">Votes</a> page.</P>
+</full_story>
+</div>
+<!--
+      END MAIN
+    -->
+</div>
+<div id="secondary_col1" class="fluid">
+<!DOCTYPE noindex PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
+<noindex>
+<div class="fluid" id="legislation">
+<ul>
+<li class="accordion-nochild">
+<a href="/legislative/bills_acts_laws.htm">Bills, Acts, &amp; Laws</a>
+</li>
+<li class="accordion-nochild">
+<a href="/legislative/nominations_new.htm">Nominations</a>
+</li>
+<li class="accordion-nochild">
+<a href="/legislative/treaties_new.htm">Treaties</a>
+</li>
+<li class="accordion-nochild">
+<a href="/legislative/votes_new.htm">Votes</a>
+</li>
+<li class="accordion-nochild">
+<a href="/legislative/floor_activity_pail.htm">Floor Proceedings</a>
+</li>
+<li class="accordion-nochild">
+<a href="/legislative/rules_procedure.htm">Rules &amp; Procedure</a>
+</li>
+<li class="accordion-nochild">
+<a href="/legislative/landmark_legislation.htm">Landmark Legislation</a>
+</li>
+<li class="accordion-nochild">
+<a href="/legislative/sessions_of_congress.htm">Sessions of Congress</a>
+</li>
+<li class="accordion-nochild">
+<a href="/legislative/senate-archives/information-about-senate-archives.htm">Senate Archives</a>
+</li>
+<li class="accordion-nochild">
+<a href="/legislative/lobbyingdisc.htm#lobbyingdisc=lda">Public Disclosure</a>
+</li>
+</ul>
+</div>
+</noindex>
+
+<!--
+            BEGIN TEASERS
+          -->
+<!--****** legislative_keys.xml Version: 1.0 was generated at: Friday, May 31, 2019: 7:56 AM EDT in folder: /Company Home/Sites/senategov/documentLibrary/Senate.gov/legislative/common/teaser **--><aside class="fluid sidebar_link_container">
+<div class="fluid content_column_container">
+<h3>Legislative Keys </h3>
+<span style="padding-top:5px" class="teasertext">
+<p>
+<a href="/legislative/KeytoVersionsofPrintedLegislation.htm">Key to Versions of Printed Legislation</a>
+<br>
+<a href="/legislative/KeytoLegislativeCitations.htm">Key to Legislative Citations</a>
+</p>
+</span>
+</div>
+</aside>
+
+<br>
+<!--****** calendar_of_business.xml Version: 3.0 was generated at: Monday, July 7, 2025: 9:53 AM EDT in folder: /Company Home/Sites/senategov/documentLibrary/Senate.gov/legislative/common/teaser **--><aside class="fluid sidebar_link_container">
+<div class="fluid content_column_container">
+<h3>Calendar of Business </h3>
+<span style="padding-top:5px" class="teasertext">
+<p>
+<a href="https://www.govinfo.gov/app/today/scal">Current</a> (GPO &ndash;  GovInfo)<br>
+<a href="https://www.govinfo.gov/app/collection/ccal/115">Past Calendars</a> (GPO &ndash;  GovInfo)<br>
+<a href="/pagelayout/legislative/one_item_and_teasers/Senate_leg_calendar_page.htm">About the Calendar</a>
+</p>
+</span>
+</div>
+</aside>
+
+<br>
+<!--****** types_of_legislation.xml Version: 1.0 was generated at: Friday, May 31, 2019: 7:56 AM EDT in folder: /Company Home/Sites/senategov/documentLibrary/Senate.gov/legislative/common/teaser **--><aside class="fluid sidebar_link_container">
+<div class="fluid content_column_container">
+<h3>Related Links </h3>
+<span style="padding-top:5px" class="teasertext">
+<p>
+<a href="/legislative/common/briefing/leg_laws_acts.htm">Types of Legislation</a>
+</p>
+</span>
+</div>
+</aside>
+
+<br>
+<!--
+            END TEASERS
+          -->
+</div>
+<div id="social_background_white" class="fluid ">
+	<div id="logo_social_footer_center" class="fluid ">
+      <div id="footer_logo" class="fluid "><a href="/index.htm"><img src="/resources/images/senate_logo_footer.png" alt="Senate Logo"/></a></div>
+     </div>
+</div>
+</main>
+<footer id="footer" class="fluid gridContainer clearfix">
+      <div id="footer_menu_center"> 
+      
+      <div id="footer_menu_senators" > 
+      	<h3><a href="/senators/contact/">SENATORS</a></h3>
+        <ul class="fluid fluidList footer_links">
+        <li><a href="/senators/senators-contact.htm">Contact</a></li>
+        <li><a href="/senators/leadership.htm">Leadership &amp; Officers</a></li>
+        <li><a href="/senators/former_senators.htm">Former Senators</a></li>
+        <li><a href="/senators/qualifications_termsofservice.htm">Qualifications &amp; Terms of Service</a></li>
+        <li><a href="/senators/facts_milestones.htm">Facts &amp; Milestones</a></li>
+          <li><a href="/states/statesmap.htm">States</a></li>
+          
+          </ul>
+          
+         <div id="footer_menu_committees" >
+         <h3  style="padding-top: 75px;"><a href="/committees/committees_home.htm">COMMITTEES</a></h3>
+         <ul class="fluid fluidList footer_links">
+          <li><a href="/committees/membership_assignments.htm">Membership &amp; Assignments</a></li>
+          <li><a href="/committees/hearings_meetings.htm">Hearings &amp; Meetings</a></li>
+          <li><a href="/committees/history.htm">History</a></li>
+          </ul></div> 
+          </div> 
+      
+          
+      <div id="footer_menu_legislation" > 
+      <h3><a href="/legislative/legislative_home.htm">LEGISLATION &amp; <br>
+RECORDS</a></h3>
+        <ul class="fluid fluidList footer_links">
+          <li><a href="/legislative/bills_acts_laws.htm">Bills, Acts, & Laws</a></li>
+          <li><a href="/legislative/nominations_new.htm">Nominations</a></li>
+          <li><a href="/legislative/treaties_new.htm">Treaties</a></li>
+          <li><a href="/legislative/votes_new.htm">Votes</a></li>
+          <li><a href="/legislative/floor_activity_pail.htm">Floor Proceedings</a></li>
+          <li><a href="/legislative/rules_procedure.htm">Rules &amp; Procedure</a></li>
+          <li><a href="/legislative/landmark_legislation.htm">Landmark Legislation</a></li>
+          <li><a href="/legislative/sessions_of_congress.htm">Sessions of Congress</a></li>
+<li><a href="/legislative/senate-archives/information-about-senate-archives.htm">Senate Archives</a></li>
+          <li><a href="/legislative/lobbyingdisc.htm#lobbyingdisc=lda">Public Disclosure</a></li>
+    
+          </ul></div> 
+          
+        
+      <div id="footer_menu_artartifacts" > 
+      <h3><a href="/art-artifacts/index.htm">ART &amp; ARTIFACTS</a></h3>
+        <ul class="fluid fluidList footer_links">
+         <li><a href="/art-artifacts/fine-art-landing-page.htm">Fine Art</a></li>
+          <li><a href="/art-artifacts/decorative-art-landing-page.htm">Decorative Art</a></li>
+         <li><a href="/art-artifacts/historical-images-landing-page.htm">Historical Images</a></li>
+          <li><a href="/art-artifacts/historical-artifacts-landing-page.htm">Historical Artifacts</a></li>
+          
+          <li><a href="/art-artifacts/thematic-collections-landing-page.htm">Thematic Collections</a></li>
+          </ul></div>
+	
+
+     <div id="footer_menu_about" > 
+      <h3><a href="/about/index.htm">ABOUT THE SENATE</a></h3>
+        <ul class="fluid fluidList footer_links">
+          <li><a href="/about/officers-staff.htm">Officers &amp; Staff</a></li>
+     <li><a href="/about/powers-procedures.htm">Powers &amp; Procedures</a></li>
+          <li><a href="/about/origins-foundations.htm">Origins &amp; Foundations</a></li>
+<li><a href="/about/parties-leadership.htm">Parties &amp; Leadership</a></li>
+<li><a href="/about/historic-buildings-spaces.htm">Historic Buildings &amp; Spaces</a></li>
+     <li><a href="/about/traditions-symbols.htm">Traditions &amp; Symbols</a></li>  
+		  <li><a href="/history/oralhistory.htm">Oral History Project</a></li>
+             <li><a href="/history/essays.htm">Historical Highlights</a></li>
+          <li><a href="/artandhistory/senate-stories/menu.htm">Senate Stories Blog</a></li> 
+<li><a href="/about/research-tools.htm">Research Tools</a></li>
+          </ul></div>
+            </div> 
+     <div id="footer_legal" class="fluid " >
+          <p><!--<span class="speaker legal"><a href="/general/common/generic/browsealoud.htm">BrowseAloud</a></span> &nbsp; | &nbsp; -->
+          <a href="/general/contacting.htm">Contact</a> &nbsp; | &nbsp; 
+          <a href="/general/content_responsibility.htm">Content Responsibility</a> &nbsp; | &nbsp; 
+          <a href="/usage/internetpolicy.htm">Usage Policy</a> &nbsp; | &nbsp; 
+  <a href="/general/privacy.htm">Privacy Policy</a> &nbsp; | &nbsp; 
+          <a href="/visiting/employment.htm">Employment &amp; Internships</a> &nbsp; | &nbsp; 
+        <a href="/visiting/procurement.htm">Procurement</a> &nbsp; | &nbsp; 
+          <a href="/index.htm">www.senate.gov</a>
+          </p>
+          </div>
+     </footer>
+     
+<script src="https://assets.adobedtm.com/566dc2d26e4f/843d2f589d53/launch-01bbfeb2a9a5.min.js" async></script>
+
+
+
+
+</body>
+</html>
diff --git a/tests/us-senate.test.js b/tests/us-senate.test.js
index 1dd5f4a..3d1e955 100644
--- a/tests/us-senate.test.js
+++ b/tests/us-senate.test.js
@@ -1,19 +1,26 @@
 import { test } from 'node:test';
 import assert from 'node:assert/strict';
 import { readFileSync } from 'node:fs';
 import { normalizeBillIdentifier } from '../src/adapters/us-congress.js';
-import { parseSenateVoteMenu, parseSenateRollCall, mapSenatePosition } from '../src/adapters/us-senate.js';
+import {
+  parseSenateVoteMenu, parseSenateRollCall, mapSenatePosition, RollCallNotYetPublishedError,
+} from '../src/adapters/us-senate.js';
+import { SourceFetchError } from '../src/lib/errors.js';
 
 const cfg = JSON.parse(readFileSync('slice.config.json', 'utf8'));
 const menuXml = readFileSync('tests/fixtures/us-senate/vote-menu.xml', 'utf8');
 const rollXml = readFileSync('tests/fixtures/us-senate/roll-call.xml', 'utf8');
+// Live-captured 2026-08-01 against real senate.gov (session 119-2, vote numbers 220/250/999 -
+// byte-identical across all three, confirming it's a fixed template, not per-vote content): the
+// HTML "Roll Call Vote Unavailable" stub LIS serves with HTTP 200 for a vote number not yet cast.
+const notYetPublishedHtml = readFileSync('tests/fixtures/us-senate/roll-call-unavailable.html', 'utf8');
 
 const POSITIONS = new Set(['yea', 'nay', 'present', 'not_voting', 'other']);
 
 test('parseSenateVoteMenu yields well over 100 votes with int vote_number and ISO date', () => {
   const menu = parseSenateVoteMenu(menuXml);
   assert.ok(menu.length > 100, `expected >100 votes, got ${menu.length}`);
   for (const v of menu) {
     assert.equal(typeof v.vote_number, 'number');
     assert.ok(Number.isInteger(v.vote_number));
     assert.match(v.date, /^\d{4}-\d{2}-\d{2}$/, `bad date for vote ${v.vote_number}: ${v.date}`);
@@ -53,19 +60,83 @@ test('parseSenateRollCall yields a full-chamber cast list including both MO sena
   for (const c of casts) {
     assert.ok(POSITIONS.has(c.position), `bad position: ${c.position}`);
     assert.ok(c.last_name.length > 0);
     assert.ok(['D', 'R', 'I', 'ID'].includes(c.party), `unexpected party: ${c.party}`);
   }
   const moSenators = casts.filter((c) => c.state === 'MO');
   assert.ok(moSenators.length > 0, 'at least one MO senator must be present');
   assert.ok(moSenators.some((c) => c.last_name === 'Hawley'));
 });
 
+// ---- defect fix (live scheduler crash, us-senate ingestion_runs row 2026-08-01T05:45:29Z):
+// probing one vote number ahead of the last-cast vote during a recess used to crash the whole
+// run with `TypeError: Cannot read properties of undefined (reading 'congress')`, because
+// senate.gov's LIS system answers a not-yet-cast vote number with HTTP 200 (never a 404) and an
+// HTML "Roll Call Vote Unavailable" stub instead of roll-call XML - so fetchSenateRollCall never
+// throws, and parseSenateRollCall blew up reading a property off the (nonexistent) XML root.
+// us-congress's sibling tail-probe already survives this exact scenario because clerk.house.gov
+// answers with a real 404, which fetchWithLimit already turns into a SourceFetchError that
+// collectUsSenate's per-vote `if (!(err instanceof SourceFetchError)) throw err;` catches,
+// counts, and continues past. The fix makes parseSenateRollCall raise that same typed error for
+// the equivalent senate.gov shape, so the existing catch handles it identically. ----
+
+test('parseSenateRollCall throws RollCallNotYetPublishedError (a SourceFetchError) on the real senate.gov "Roll Call Vote Unavailable" stub, not a TypeError', () => {
+  assert.throws(
+    () => parseSenateRollCall(notYetPublishedHtml),
+    (err) => {
+      assert.ok(err instanceof RollCallNotYetPublishedError, `expected RollCallNotYetPublishedError, got ${err.constructor.name}`);
+      // The load-bearing property: collectUsSenate's per-vote catch is `if (!(err instanceof
+      // SourceFetchError)) throw err;` - unless this holds, the crash reproduces unchanged.
+      assert.ok(err instanceof SourceFetchError, 'must be a SourceFetchError so collectUsSenate treats it as an expected miss, not a crash');
+      assert.notEqual(err.constructor.name, 'TypeError');
+      assert.equal(err.source, 'us-senate');
+      assert.match(err.message, /not yet|unavailable/i);
+      return true;
+    },
+  );
+});
+
+test('parseSenateRollCall still fails loudly (not a SourceFetchError) on a genuinely malformed payload for an existing vote, never confused with the not-yet-published stub', () => {
+  // Well-formed enough for fast-xml-parser to accept without a parser-level exception (a raw XML
+  // syntax error, e.g. an unclosed tag from mid-stream truncation, already fails loudly on its
+  // own - fast-xml-parser throws directly and parseSenateRollCall does not wrap that call in a
+  // try/catch, so nothing here needs to convert it). This is the OTHER malformed shape: a
+  // response that parses fine but is neither a real roll call NOR the recognized "Roll Call Vote
+  // Unavailable" stub (e.g. an unexpected error page, a differently-shaped upstream response) -
+  // proving the fix's guard is scoped to the one recognized stub, not a blanket swallow of every
+  // rootless payload.
+  const corrupted = '<?xml version="1.0" encoding="UTF-8"?><corrupted_response>truncated mid-stream</corrupted_response>';
+  assert.throws(
+    () => parseSenateRollCall(corrupted),
+    (err) => {
+      assert.ok(!(err instanceof RollCallNotYetPublishedError), 'must not be misclassified as the not-yet-published case');
+      assert.ok(!(err instanceof SourceFetchError), 'must NOT be a SourceFetchError - collectUsSenate must not swallow real corruption as an expected miss');
+      assert.match(err.message, /genuine parse failure/);
+      return true;
+    },
+  );
+});
+
+test('parseSenateRollCall lets a raw XML syntax error (e.g. mid-stream truncation cutting off the XML declaration itself) propagate unmodified - never reclassified as an expected miss', () => {
+  // Real observed behavior: fast-xml-parser itself throws ("Pi Tag is not closed.") for input
+  // this badly truncated, before parseSenateRollCall's own root-check ever runs. Confirms the fix
+  // does not wrap xmlParser.parse() in a try/catch anywhere - a genuine parser-level exception
+  // must reach the caller exactly as fast-xml-parser raised it.
+  const truncated = rollXml.slice(0, 20);
+  assert.throws(
+    () => parseSenateRollCall(truncated),
+    (err) => {
+      assert.ok(!(err instanceof SourceFetchError), 'a raw parser exception must not be a SourceFetchError either');
+      return true;
+    },
+  );
+});
+
 test('mapSenatePosition covers the documented enum, including impeachment-style Guilty/Not Guilty', () => {
   assert.equal(mapSenatePosition('Yea'), 'yea');
   assert.equal(mapSenatePosition('Guilty'), 'yea');
   assert.equal(mapSenatePosition('Nay'), 'nay');
   assert.equal(mapSenatePosition('Not Guilty'), 'nay');
   assert.equal(mapSenatePosition('Present'), 'present');
   assert.equal(mapSenatePosition('Not Voting'), 'not_voting');
   assert.equal(mapSenatePosition('Absent'), 'other');
 });
