-- Categories and channels lifted verbatim from the two Google Forms, with the
-- Fixed/Variable split taken from the monthly budget workbook.

insert into categories (kind, name, bucket, sort_order) values
  ('expense', 'Rent',                        'fixed',    10),
  ('expense', 'Phone',                       'fixed',    20),
  ('expense', 'Insurance',                   'fixed',    30),
  ('expense', 'Subscriptions',               'fixed',    40),
  ('expense', 'Banking Fees',                'fixed',    50),
  ('expense', 'Yearly Subscriptions',        'variable', 60),
  ('expense', 'Transportation',              'variable', 70),
  ('expense', 'Gifts & Presents',            'variable', 80),
  ('expense', 'Groceries',                   'variable', 90),
  ('expense', 'Eating Out',                  'variable', 100),
  ('expense', 'Personal Care',               'variable', 110),
  ('expense', 'Health',                      'variable', 120),
  ('expense', 'Capital Items',               'variable', 130),
  ('expense', 'Entertainment & Socializing', 'variable', 140),
  ('expense', 'Charity',                     'variable', 150),
  ('expense', 'Trips & Travel',              'variable', 160),
  ('expense', 'Others',                      'variable', 170)
on conflict (kind, name) do nothing;

insert into categories (kind, name, sort_order) values
  ('income', 'Salary',          10),
  ('income', 'Payback',         20),
  ('income', 'Refund',          30),
  ('income', 'Insurance Claim', 40),
  ('income', 'Other Income',    50),
  ('income', 'Trip Related',    60),
  -- Present in the historical income sheet but not on the current form.
  ('income', 'Returns',         70)
on conflict (kind, name) do nothing;

insert into channels (name, kinds, sort_order) values
  ('BOI Credit Card',    array['expense'],           10),
  ('BOI Current Account', array['expense','income'], 20),
  ('Revolut',            array['expense','income'],  30),
  ('Cash',               array['expense','income'],  40),
  ('Other',              array['expense','income'],  50)
on conflict (name) do nothing;
