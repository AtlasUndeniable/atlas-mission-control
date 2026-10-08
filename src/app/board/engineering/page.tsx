import ActionBoard from '@/components/ActionBoard';
// Existing middleware and /api/board retain their Rhys-only authorization.
// Deliberately absent from team-facing meeting-board navigation.
export const dynamic='force-dynamic';
export default function EngineeringPage(){return <ActionBoard initialFilter="engineering"/>}
