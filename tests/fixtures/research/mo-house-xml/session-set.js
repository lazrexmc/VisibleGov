var sessionyearcode = '261';
var baseURL = 'https://documents.house.mo.gov/xml/261-';

var specsessionyearcode = '253';
var specbaseURL = 'https://documents.house.mo.gov/xml/253-';

var specsession2yearcode = '254';
var specbaseURL2 = 'https://documents.house.mo.gov/xml/254-';

var showSpec = 'false';

function SetLinks()
{
	if (document.getElementById('sessionHeading') != null) {
		document.getElementById('sessionHeading').innerHTML = sessionyearcode + '&nbsp;' + document.getElementById('sessionHeading').innerHTML;
	}
	if (document.getElementById('sessionList') != null){
		document.getElementById('sessionList').href = baseURL + 'SessionList.XML';
	}
	if (document.getElementById('billList') != null) {
		document.getElementById('billList').href = baseURL + 'BillList.XML';
	}
	if (document.getElementById('billList2') != null) {
		document.getElementById('billList2').href = baseURL + 'BillList.XML';
	}
	if (document.getElementById('memberList') != null) {
		document.getElementById('memberList').href = baseURL + 'MemberList.XML';
	}
	if (document.getElementById('memberList2') != null) {
		document.getElementById('memberList2').href = baseURL + 'MemberList.XML';
	}
	if (document.getElementById('committeeList') != null) {
		document.getElementById('committeeList').href = baseURL + 'CommitteeList.XML';
	}
	if (document.getElementById('upcomingHearingList') != null) {
		document.getElementById('upcomingHearingList').href = baseURL + 'UpcomingHearingList.XML';
	}
	if (document.getElementById('calendarList') != null) {
		document.getElementById('calendarList').href = baseURL + 'CalendarList.XML';
	}
	
	if (document.getElementById('senateActList') != null) {
		document.getElementById('senateActList').href = baseURL + 'SenateActList.XML';
	}
	
	if (document.getElementById('sessionList') != null) {
		document.getElementById('sessionList').innerHTML = sessionyearcode + '-' + document.getElementById('sessionList').innerHTML;
	}
	if (document.getElementById('billList') != null) {
		document.getElementById('billList').innerHTML = sessionyearcode + '-' + document.getElementById('billList').innerHTML;
	}
	if (document.getElementById('billList2') != null) {
		document.getElementById('billList2').innerHTML = sessionyearcode + '-' + document.getElementById('billList2').innerHTML;
	}
	if (document.getElementById('memberList') != null) {
		document.getElementById('memberList').innerHTML = sessionyearcode + '-' + document.getElementById('memberList').innerHTML;
	}
	if (document.getElementById('memberList2') != null) {
		document.getElementById('memberList2').innerHTML = sessionyearcode + '-' + document.getElementById('memberList2').innerHTML;
	}
	if (document.getElementById('committeeList') != null) {
		document.getElementById('committeeList').innerHTML = sessionyearcode + '-' + document.getElementById('committeeList').innerHTML;
	}
	if (document.getElementById('upcomingHearingList') != null) {
		document.getElementById('upcomingHearingList').innerHTML = sessionyearcode + '-' + document.getElementById('upcomingHearingList').innerHTML;
	}
	if (document.getElementById('calendarList') != null) {
		document.getElementById('calendarList').innerHTML = sessionyearcode + '-' + document.getElementById('calendarList').innerHTML;
	}
	if (document.getElementById('senateActList') != null) {
		document.getElementById('senateActList').innerHTML = sessionyearcode + '-' + document.getElementById('senateActList').innerHTML;
	}
	
	//Special Session links
	
	if (showSpec == 'true')
	{
		if (document.getElementById('show1') != null)
		{
			if (document.getElementById('show1').tagName === 'LI')
				document.getElementById('show1').style.display = 'list-item';
			else
				document.getElementById('show1').style.display = 'block';
		}
		
		if (document.getElementById('show2') != null)
		{
			if (document.getElementById('show2').tagName === 'LI')
				document.getElementById('show2').style.display = 'list-item';
			else
				document.getElementById('show2').style.display = 'block';
		}
		
		if (document.getElementById('show3') != null)
		{
			if (document.getElementById('show3').tagName === 'LI')
				document.getElementById('show3').style.display = 'list-item';
			else
				document.getElementById('show3').style.display = 'block';
		}
		
		if (document.getElementById('show4') != null)
		{
			if (document.getElementById('show4').tagName === 'LI')
				document.getElementById('show4').style.display = 'list-item';
			else
				document.getElementById('show4').style.display = 'block';
		}
		
		if (document.getElementById('show5') != null)
		{
			if (document.getElementById('show5').tagName === 'LI')
				document.getElementById('show5').style.display = 'list-item';
			else
				document.getElementById('show5').style.display = 'block';
		}
		
		if (document.getElementById('show6') != null)
		{
			if (document.getElementById('show6').tagName === 'LI')
				document.getElementById('show6').style.display = 'list-item';
			else
				document.getElementById('show6').style.display = 'block';
		}
		
		if (document.getElementById('specSession2Heading') != null) {
			document.getElementById('specSession2Heading').innerHTML = specsession2yearcode + '&nbsp;' + document.getElementById('specSession2Heading').innerHTML;
		}
		if (document.getElementById('specSession2Heading') != null)
		{
			document.getElementById('specSession2Heading').style.display = 'block';
		}
		if (document.getElementById('specSession2List') != null){
			document.getElementById('specSession2List').href = specbaseURL2 + 'SessionList.XML';
		}                            
		if (document.getElementById('spec2BillList') != null) {
			document.getElementById('spec2BillList').href = specbaseURL2 + 'BillList.XML';
		}                            
		if (document.getElementById('spec2BillList2') != null) {
			document.getElementById('spec2BillList2').href = specbaseURL2 + 'BillList.XML';
		}                            
		if (document.getElementById('spec2MemberList') != null) {
			document.getElementById('spec2MemberList').href = specbaseURL2 + 'MemberList.XML';
		}                            
		if (document.getElementById('spec2MemberList2') != null) {
			document.getElementById('spec2MemberList2').href = specbaseURL2 + 'MemberList.XML';
		}                            
		if (document.getElementById('spec2CommitteeList') != null) {
			document.getElementById('spec2CommitteeList').href = specbaseURL2 + 'CommitteeList.XML';
		}                            
		if (document.getElementById('spec2UpcomingHearingList') != null) {
			document.getElementById('spec2UpcomingHearingList').href = specbaseURL2 + 'UpcomingHearingList.XML';
		}                            
		if (document.getElementById('spec2CalendarList') != null) {
			document.getElementById('spec2CalendarList').href = specbaseURL2 + 'CalendarList.XML';
		}                            
		if (document.getElementById('spec2SenateActList') != null) {
			document.getElementById('spec2SenateActList').href = specbaseURL2 + 'SenateActList.XML';
		}                            
		if (document.getElementById('specSession2List') != null) {
			document.getElementById('specSession2List').innerHTML = specsession2yearcode + '-' + document.getElementById('specSession2List').innerHTML;
		} 
		if (document.getElementById('spec2BillList') != null) {
			document.getElementById('spec2BillList').innerHTML = specsession2yearcode + '-' + document.getElementById('spec2BillList').innerHTML;
		} 
		if (document.getElementById('spec2BillList2') != null) {
			document.getElementById('spec2BillList2').innerHTML = specsession2yearcode + '-' + document.getElementById('spec2BillList2').innerHTML;
		} 
		if (document.getElementById('spec2MemberList') != null) {
			document.getElementById('spec2MemberList').innerHTML = specsession2yearcode + '-' + document.getElementById('spec2MemberList').innerHTML;
		} 
		if (document.getElementById('spec2MemberList2') != null) {
			document.getElementById('spec2MemberList2').innerHTML = specsession2yearcode + '-' + document.getElementById('spec2MemberList2').innerHTML;
		} 
		if (document.getElementById('spec2CommitteeList') != null) {
			document.getElementById('spec2CommitteeList').innerHTML = specsession2yearcode + '-' + document.getElementById('spec2CommitteeList').innerHTML;
		} 
		if (document.getElementById('spec2UpcomingHearingList') != null) {
			document.getElementById('spec2UpcomingHearingList').innerHTML = specsession2yearcode + '-' + document.getElementById('spec2UpcomingHearingList').innerHTML;
		} 
		if (document.getElementById('spec2CalendarList') != null) {
			document.getElementById('spec2CalendarList').innerHTML = specsession2yearcode + '-' + document.getElementById('spec2CalendarList').innerHTML;
		}
		if (document.getElementById('spec2SenateActList') != null) {
			document.getElementById('spec2SenateActList').innerHTML = specsession2yearcode + '-' + document.getElementById('spec2SenateActList').innerHTML;
		}
	
		if (document.getElementById('specSessionHeading') != null)
		{
			document.getElementById('specSessionHeading').style.display = 'block';
		}
		if (document.getElementById('specSessionHeading') != null) {
			document.getElementById('specSessionHeading').innerHTML = specsessionyearcode + '&nbsp;' + document.getElementById('specSessionHeading').innerHTML;
		}                            
		if (document.getElementById('specSessionList') != null){
			document.getElementById('specSessionList').href = specbaseURL + 'SessionList.XML';
		}                            
		if (document.getElementById('specBillList') != null) {
			document.getElementById('specBillList').href = specbaseURL + 'BillList.XML';
		}                            
		if (document.getElementById('specBillList2') != null) {
			document.getElementById('specBillList2').href = specbaseURL + 'BillList.XML';
		}                            
		if (document.getElementById('specMemberList') != null) {
			document.getElementById('specMemberList').href = specbaseURL + 'MemberList.XML';
		}                            
		if (document.getElementById('specMemberList2') != null) {
			document.getElementById('specMemberList2').href = specbaseURL + 'MemberList.XML';
		}                            
		if (document.getElementById('specCommitteeList') != null) {
			document.getElementById('specCommitteeList').href = specbaseURL + 'CommitteeList.XML';
		}                            
		if (document.getElementById('specUpcomingHearingList') != null) {
			document.getElementById('specUpcomingHearingList').href = specbaseURL + 'UpcomingHearingList.XML';
		}                            
		if (document.getElementById('specCalendarList') != null) {
			document.getElementById('specCalendarList').href = specbaseURL + 'CalendarList.XML';
		}                            
		if (document.getElementById('specSenateActList') != null) {
			document.getElementById('specSenateActList').href = specbaseURL + 'SenateActList.XML';
		}                            
		if (document.getElementById('specSessionList') != null) {
			document.getElementById('specSessionList').innerHTML = specsessionyearcode + '-' + document.getElementById('specSessionList').innerHTML;
		} 
		if (document.getElementById('specBillList') != null) {
			document.getElementById('specBillList').innerHTML = specsessionyearcode + '-' + document.getElementById('specBillList').innerHTML;
		} 
		if (document.getElementById('specBillList2') != null) {
			document.getElementById('specBillList2').innerHTML = specsessionyearcode + '-' + document.getElementById('specBillList2').innerHTML;
		} 
		if (document.getElementById('specMemberList') != null) {
			document.getElementById('specMemberList').innerHTML = specsessionyearcode + '-' + document.getElementById('specMemberList').innerHTML;
		} 
		if (document.getElementById('specMemberList2') != null) {
			document.getElementById('specMemberList2').innerHTML = specsessionyearcode + '-' + document.getElementById('specMemberList2').innerHTML;
		} 
		if (document.getElementById('specCommitteeList') != null) {
			document.getElementById('specCommitteeList').innerHTML = specsessionyearcode + '-' + document.getElementById('specCommitteeList').innerHTML;
		} 
		if (document.getElementById('specUpcomingHearingList') != null) {
			document.getElementById('specUpcomingHearingList').innerHTML = specsessionyearcode + '-' + document.getElementById('specUpcomingHearingList').innerHTML;
		} 
		if (document.getElementById('specCalendarList') != null) {
			document.getElementById('specCalendarList').innerHTML = specsessionyearcode + '-' + document.getElementById('specCalendarList').innerHTML;
		}
		if (document.getElementById('specSenateActList') != null) {
			document.getElementById('specSenateActList').innerHTML = specsessionyearcode + '-' + document.getElementById('specSenateActList').innerHTML;
		}
	}
}