drop policy if exists "merchant submits own profile changes" on public.merchant_profile_submissions;
create policy "merchant submits own profile changes" on public.merchant_profile_submissions
for insert to authenticated with check (
  merchant_id=auth.uid() and status='pending'
  and exists(select 1 from public.profiles p where p.id=auth.uid() and p.role in ('usuario','comercio'))
);