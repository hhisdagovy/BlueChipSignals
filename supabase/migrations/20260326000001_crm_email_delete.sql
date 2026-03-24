-- Allow CRM users to delete email threads and their messages
-- (requires crm_can_access_mailbox for the thread's mailbox)

drop policy if exists email_messages_delete on public.email_messages;
create policy email_messages_delete
on public.email_messages
for delete
to authenticated
using (
  public.crm_can_access_mailbox(email_messages.sender_mailbox_id)
);

drop policy if exists email_threads_delete on public.email_threads;
create policy email_threads_delete
on public.email_threads
for delete
to authenticated
using (
  public.crm_can_access_mailbox(email_threads.mailbox_sender_id)
);

grant delete on public.email_messages to authenticated;
grant delete on public.email_threads to authenticated;
