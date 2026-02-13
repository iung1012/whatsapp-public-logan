import { WASocket, GroupMetadata } from '@whiskeysockets/baileys';
import { ALLOWED_GROUPS } from './config';
import { isCurrentlyShabbat, areGroupsAlreadyLocked } from './shabbatLocker';
import { calculateBotScores, detectMassJoin, formatBotScore, BotScore } from './utils/botDetection';

// Configuration
const AUTO_PROCESS_ENABLED = process.env.AUTO_PROCESS_JOIN_REQUESTS === 'true';
const BOT_THRESHOLD = parseInt(process.env.JOIN_REQUEST_BOT_THRESHOLD || '3', 10);
const MAX_GROUP_SIZE = parseInt(process.env.MAX_GROUP_SIZE || '1024', 10);
const NOTIFY_ADMINS = (process.env.JOIN_REQUEST_NOTIFY_ADMINS || process.env.SPAM_ADMIN_NOTIFY || '').split(',').filter(Boolean);
const WHITELIST = (process.env.SPAM_WHITELIST || '').split(',').filter(Boolean);

export interface ProcessingResult {
  groupName: string;
  approved: string[];
  rejected: string[];
  waitlisted: string[];
  errors: string[];
}

/**
 * Check if a user is whitelisted (trusted).
 */
function isWhitelisted(jid: string): boolean {
  const phoneNumber = jid.replace('@s.whatsapp.net', '');
  return WHITELIST.includes(phoneNumber) || WHITELIST.includes(jid);
}

/**
 * Check if the bot is an admin in the group.
 */
async function isBotAdmin(sock: WASocket, groupId: string): Promise<boolean> {
  try {
    const metadata: GroupMetadata = await sock.groupMetadata(groupId);

    // Try both JID formats - groups use LID format (@lid), not regular JID (@s.whatsapp.net)
    const botJid = sock.user?.id;
    const botLid = sock.user?.lid;

    if (!botJid && !botLid) return false;

    // Extract LID prefix (before the colon)
    // Bot LID format: "1602794598430:9@lid"
    // Participant LID format: "1602794598430@lid"
    const botLidPrefix = botLid ? botLid.split(':')[0] + '@lid' : null;

    console.log(`[${new Date().toISOString()}] [JoinRequest] Checking admin status:`);
    console.log(`[${new Date().toISOString()}] [JoinRequest]   Bot JID: ${botJid}`);
    console.log(`[${new Date().toISOString()}] [JoinRequest]   Bot LID: ${botLid}`);
    console.log(`[${new Date().toISOString()}] [JoinRequest]   Bot LID prefix: ${botLidPrefix}`);

    // Find bot in participants using LID prefix match
    const botParticipant = metadata.participants.find(p => {
      const matches = p.id === botJid || p.id === botLid || p.id === botLidPrefix;
      if (matches) {
        console.log(`[${new Date().toISOString()}] [JoinRequest]   ✓ Found bot: ${p.id}, admin: ${p.admin || 'none'}`);
      }
      return matches;
    });

    if (!botParticipant) {
      console.log(`[${new Date().toISOString()}] [JoinRequest]   ✗ Bot not found in participants`);
      return false;
    }

    const isAdmin = botParticipant.admin === 'admin' || botParticipant.admin === 'superadmin';
    console.log(`[${new Date().toISOString()}] [JoinRequest]   Admin check result: ${isAdmin}`);
    return isAdmin;
  } catch (error) {
    console.error(`[${new Date().toISOString()}] [JoinRequest] Failed to check admin status:`, error);
    return false;
  }
}

/**
 * Get current group size and calculate available slots.
 */
async function getGroupCapacity(sock: WASocket, groupId: string): Promise<{
  currentSize: number;
  maxSize: number;
  availableSlots: number;
}> {
  try {
    const metadata: GroupMetadata = await sock.groupMetadata(groupId);
    const currentSize = metadata.participants.length;
    const availableSlots = Math.max(0, MAX_GROUP_SIZE - currentSize);

    return {
      currentSize,
      maxSize: MAX_GROUP_SIZE,
      availableSlots,
    };
  } catch (error) {
    console.error(`[${new Date().toISOString()}] [JoinRequest] Failed to get group capacity:`, error);
    return {
      currentSize: 0,
      maxSize: MAX_GROUP_SIZE,
      availableSlots: 0,
    };
  }
}

/**
 * Fetch pending join requests for a group.
 */
async function fetchJoinRequests(sock: WASocket, groupId: string): Promise<string[]> {
  try {
    const requests = await sock.groupRequestParticipantsList(groupId);

    // Handle different return types from Baileys API
    if (!requests) return [];

    // If it's an array of objects with jid property, extract the jids
    if (Array.isArray(requests) && requests.length > 0 && typeof requests[0] === 'object') {
      return (requests as any).map((r: any) => r.jid || r);
    }

    // If it's already an array of strings, return as is
    if (Array.isArray(requests) && (requests.length === 0 || typeof requests[0] === 'string')) {
      return requests as any;
    }

    console.warn(`[${new Date().toISOString()}] [JoinRequest] Unexpected requests format:`, requests);
    return [];
  } catch (error) {
    console.error(`[${new Date().toISOString()}] [JoinRequest] Failed to fetch requests for ${groupId}:`, error);
    return [];
  }
}

/**
 * Approve join requests.
 */
async function approveRequests(sock: WASocket, groupId: string, jids: string[]): Promise<boolean> {
  if (jids.length === 0) return true;

  try {
    await sock.groupRequestParticipantsUpdate(groupId, jids, 'approve');
    console.log(`[${new Date().toISOString()}] [JoinRequest] Approved ${jids.length} requests for ${groupId}`);
    return true;
  } catch (error) {
    console.error(`[${new Date().toISOString()}] [JoinRequest] Failed to approve requests:`, error);
    return false;
  }
}

/**
 * Reject join requests.
 */
async function rejectRequests(sock: WASocket, groupId: string, jids: string[]): Promise<boolean> {
  if (jids.length === 0) return true;

  try {
    await sock.groupRequestParticipantsUpdate(groupId, jids, 'reject');
    console.log(`[${new Date().toISOString()}] [JoinRequest] Rejected ${jids.length} requests for ${groupId}`);
    return true;
  } catch (error) {
    console.error(`[${new Date().toISOString()}] [JoinRequest] Failed to reject requests:`, error);
    return false;
  }
}

/**
 * Send notification to admins about processing results.
 */
async function notifyAdmins(sock: WASocket, result: ProcessingResult): Promise<void> {
  if (NOTIFY_ADMINS.length === 0) return;

  // Respect Shabbat
  if (isCurrentlyShabbat() || areGroupsAlreadyLocked()) {
    console.log(`[${new Date().toISOString()}] [JoinRequest] Shabbat active - skipping admin notification`);
    return;
  }

  const hasActions = result.approved.length > 0 || result.rejected.length > 0 || result.waitlisted.length > 0;
  if (!hasActions) return; // Don't spam if nothing happened

  const notification = [
    `🤖 *סיכום בקשות הצטרפות - ${result.groupName}*`,
    ``,
    `✅ אושרו: ${result.approved.length} אנשים`,
    `❌ נדחו (בוטים): ${result.rejected.length} חשבונות`,
    `⏳ בהמתנה (קבוצה מלאה): ${result.waitlisted.length} אנשים`,
  ];

  // Add details for rejected (bots)
  if (result.rejected.length > 0) {
    notification.push('');
    notification.push('*נדחו:*');
    result.rejected.slice(0, 5).forEach(jid => {
      const phone = jid.replace('@s.whatsapp.net', '');
      notification.push(`❌ +${phone}`);
    });
    if (result.rejected.length > 5) {
      notification.push(`... ועוד ${result.rejected.length - 5}`);
    }
  }

  const message = notification.join('\n');

  for (const adminPhone of NOTIFY_ADMINS) {
    try {
      const adminJid = adminPhone.includes('@') ? adminPhone : `${adminPhone}@s.whatsapp.net`;
      await sock.sendMessage(adminJid, { text: message });
    } catch (error) {
      console.error(`[${new Date().toISOString()}] [JoinRequest] Failed to notify admin ${adminPhone}:`, error);
    }
  }
}

/**
 * Process join requests for a single group.
 */
export async function processGroupJoinRequests(
  sock: WASocket,
  groupId: string,
  groupName: string
): Promise<ProcessingResult> {
  const result: ProcessingResult = {
    groupName,
    approved: [],
    rejected: [],
    waitlisted: [],
    errors: [],
  };

  console.log(`[${new Date().toISOString()}] [JoinRequest] Processing ${groupName}...`);

  // Check if bot is admin
  const isAdmin = await isBotAdmin(sock, groupId);
  if (!isAdmin) {
    console.log(`[${new Date().toISOString()}] [JoinRequest] Bot is not admin in ${groupName} - skipping`);
    result.errors.push('bot_not_admin');
    return result;
  }

  // Fetch pending requests
  const pendingJids = await fetchJoinRequests(sock, groupId);
  if (pendingJids.length === 0) {
    console.log(`[${new Date().toISOString()}] [JoinRequest] No pending requests for ${groupName}`);
    return result;
  }

  console.log(`[${new Date().toISOString()}] [JoinRequest] Found ${pendingJids.length} pending requests`);

  // Get group capacity
  const capacity = await getGroupCapacity(sock, groupId);
  console.log(`[${new Date().toISOString()}] [JoinRequest] Group capacity: ${capacity.currentSize}/${capacity.maxSize} (${capacity.availableSlots} slots available)`);

  // Calculate bot scores for all pending requests
  const botScores = await calculateBotScores(sock, pendingJids);

  // Check for mass join attack
  const massJoinCheck = detectMassJoin(pendingJids.length);
  if (massJoinCheck.isMassJoin) {
    console.log(`[${new Date().toISOString()}] [JoinRequest] ⚠️ Mass join detected! Adding ${massJoinCheck.scoreModifier} to all scores`);
  }

  // Categorize requests
  const toApprove: string[] = [];
  const toReject: string[] = [];
  const toWaitlist: string[] = [];

  for (const jid of pendingJids) {
    const score = botScores.get(jid);
    if (!score) {
      console.log(`[${new Date().toISOString()}] [JoinRequest] No score for ${jid} - waitlisting`);
      toWaitlist.push(jid);
      continue;
    }

    // Apply mass join modifier
    const finalScore = score.score + massJoinCheck.scoreModifier;
    const isBot = finalScore >= BOT_THRESHOLD;

    console.log(`[${new Date().toISOString()}] [JoinRequest] ${jid}: ${formatBotScore(score)} + mass_join(${massJoinCheck.scoreModifier}) = ${finalScore}`);

    // Whitelist always gets approved (if room available)
    if (isWhitelisted(jid)) {
      console.log(`[${new Date().toISOString()}] [JoinRequest] ${jid} is whitelisted - approving`);
      toApprove.push(jid);
      continue;
    }

    // Reject bots
    if (isBot) {
      console.log(`[${new Date().toISOString()}] [JoinRequest] ${jid} is likely a bot (score ${finalScore}) - rejecting`);
      toReject.push(jid);
      continue;
    }

    // Approve humans if room available
    if (capacity.availableSlots > toApprove.length) {
      console.log(`[${new Date().toISOString()}] [JoinRequest] ${jid} looks human and room available - approving`);
      toApprove.push(jid);
    } else {
      console.log(`[${new Date().toISOString()}] [JoinRequest] ${jid} looks human but group is full - waitlisting`);
      toWaitlist.push(jid);
    }
  }

  // Execute actions
  if (toApprove.length > 0) {
    const success = await approveRequests(sock, groupId, toApprove);
    if (success) {
      result.approved = toApprove;
    } else {
      result.errors.push('approve_failed');
    }
  }

  if (toReject.length > 0) {
    const success = await rejectRequests(sock, groupId, toReject);
    if (success) {
      result.rejected = toReject;
    } else {
      result.errors.push('reject_failed');
    }
  }

  result.waitlisted = toWaitlist;

  // Notify admins
  await notifyAdmins(sock, result);

  return result;
}

/**
 * Process join requests for all groups where bot is admin.
 */
export async function processAllGroupJoinRequests(sock: WASocket): Promise<ProcessingResult[]> {
  if (!AUTO_PROCESS_ENABLED) {
    console.log(`[${new Date().toISOString()}] [JoinRequest] Auto-processing is disabled`);
    return [];
  }

  // Respect Shabbat
  if (isCurrentlyShabbat() || areGroupsAlreadyLocked()) {
    console.log(`[${new Date().toISOString()}] [JoinRequest] Shabbat/Holiday active - skipping join request processing`);
    return [];
  }

  console.log(`[${new Date().toISOString()}] [JoinRequest] Starting join request processing for all groups...`);

  const groups = ALLOWED_GROUPS.filter(g => g.id.endsWith('@g.us'));
  const results: ProcessingResult[] = [];

  for (const group of groups) {
    try {
      const result = await processGroupJoinRequests(sock, group.id, group.name);
      results.push(result);

      // Add small delay between groups to avoid rate limits
      await new Promise(resolve => setTimeout(resolve, 1000));
    } catch (error) {
      console.error(`[${new Date().toISOString()}] [JoinRequest] Error processing ${group.name}:`, error);
      results.push({
        groupName: group.name,
        approved: [],
        rejected: [],
        waitlisted: [],
        errors: ['processing_error'],
      });
    }
  }

  console.log(`[${new Date().toISOString()}] [JoinRequest] Finished processing ${results.length} groups`);

  return results;
}

export function isJoinRequestProcessingEnabled(): boolean {
  return AUTO_PROCESS_ENABLED;
}
