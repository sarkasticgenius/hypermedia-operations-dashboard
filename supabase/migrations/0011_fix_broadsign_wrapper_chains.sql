-- The 6 real combined-chain wrappers from the original app's BROADSIGN_WRAPPERS table were
-- migrated with is_combined=true but chain left null, so resolveMembers() (which needs `chain`
-- to find a wrapper's member locations) always resolved zero members - the wrapper tiles were
-- silently empty and their individual member stations/bridges never got hidden/merged.
update locations set chain = 'Red Line' where lower(name) = lower('Metro Red Line') and is_combined = true;
update locations set chain = 'Green Line' where lower(name) = lower('Metro Green Line') and is_combined = true;
update locations set chain = 'Expo Line' where lower(name) = lower('Metro Expo Line') and is_combined = true;
update locations set chain = 'Metro Bridges' where lower(name) = lower('Metro Bridges') and is_combined = true;
update locations set chain = 'Expo City' where lower(name) = lower('Expo City') and is_combined = true;
update locations set chain = 'Nakheel Pavilions', is_combined = true where lower(name) = lower('Nakheel Pavillions');
