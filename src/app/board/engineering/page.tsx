import ActionBoard from '@/components/ActionBoard';
import MeetingQueue from '@/components/MeetingQueue';
// Existing middleware and /api/board retain their Rhys-only authorization.
// Deliberately absent from team-facing meeting-board navigation.
//
// Identifiers the customer board removes — request/task/source ids, item and
// source revisions, draft hashes, migration and build detail — stay here, on
// the same data and the same permissions, so nothing is lost by taking them
// off Rhys's daily view.
export const dynamic='force-dynamic';
export default function EngineeringPage(){
 return process.env.ATLAS_MEETING_QUEUE==='1'?<MeetingQueue engineering/>:<ActionBoard initialFilter="engineering"/>;
}
