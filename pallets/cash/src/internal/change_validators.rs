use crate::{
    internal, reason::Reason, require, types::ValidatorKeys, Config, Event, Module, NextValidators,
    NoticeHolds, SessionInterface,
};
use frame_support::storage::{IterableStorageMap, StorageMap};

pub fn change_validators<T: Config>(validators: Vec<ValidatorKeys>) -> Result<(), Reason> {
    require!(NoticeHolds::iter().count() == 0, Reason::PendingAuthNotice);

    for validator in validators.iter() {
        require!(
            <T>::SessionInterface::has_next_keys(validator.substrate_id.clone()),
            Reason::ChangeValidatorsError
        );
    }

    for (id, _keys) in NextValidators::iter() {
        NextValidators::take(&id);
    }
    for keys in &validators {
        NextValidators::insert(&keys.substrate_id, keys);
    }

    <Module<T>>::deposit_event(Event::ChangeValidators(validators.clone()));

    internal::notices::dispatch_change_authority_notice::<T>(validators);

    // rotate to the currently queued session, and queue a new session with the new validators in NextValidators
    <T>::SessionInterface::rotate_session();

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        chains::*, notices::*, reason::Reason, tests::*, AccountId32, LatestNotice, NoticeStates,
        Notices, ValidatorKeys,
    };
    use frame_support::storage::{IterableStorageDoubleMap, StorageDoubleMap, StorageMap};
    use mock::opaque::MockSessionKeys;

    #[test]
    fn test_change_validators() {
        new_test_ext().execute_with(|| {
            let prev_substrate_id: AccountId32 = [8; 32].into();
            let prev_keys = ValidatorKeys {
                substrate_id: prev_substrate_id.clone(),
                eth_address: [9; 20],
            };

            NextValidators::insert(prev_substrate_id, prev_keys);

            let substrate_id: AccountId32 = [2; 32].into();
            let eth_address = [1; 20];
            let val_keys = vec![ValidatorKeys {
                substrate_id: substrate_id.clone(),
                eth_address: eth_address.clone(),
            }];
            let session_keys = MockSessionKeys { dummy: 1u64.into() };
            assert_eq!(
                Ok(()),
                Session::set_keys(
                    frame_system::RawOrigin::Signed(substrate_id.clone()).into(),
                    session_keys.clone(),
                    vec![]
                )
            );
            assert_eq!(change_validators::<Test>(val_keys.clone()), Ok(()));
            let val_state_post: Vec<ValidatorKeys> =
                NextValidators::iter().map(|x| x.1).collect::<Vec<_>>();
            assert_eq!(val_state_post, val_keys);

            let notice_state_post: Vec<(ChainId, NoticeId, NoticeState)> =
                NoticeStates::iter().collect();
            let notice_state = notice_state_post.into_iter().next().unwrap();
            let notice = Notices::get(notice_state.0, notice_state.1);

            // bumps era
            let expected_notice_id = NoticeId(1, 0);
            let expected_notice = Notice::ChangeAuthorityNotice(ChangeAuthorityNotice::Eth {
                id: expected_notice_id,
                parent: [0u8; 32],
                new_authorities: vec![eth_address],
            });

            assert_eq!(
                (
                    ChainId::Eth,
                    expected_notice_id,
                    NoticeState::Pending {
                        signature_pairs: ChainSignatureList::Eth(vec![])
                    }
                ),
                notice_state
            );
            assert_eq!(notice, Some(expected_notice.clone()));
            assert_eq!(
                LatestNotice::get(ChainId::Eth),
                Some((expected_notice_id, expected_notice.hash()))
            );

            assert_eq!(
                vec![&(substrate_id, session_keys)],
                Session::queued_keys().iter().collect::<Vec<_>>()
            );

            // Check emitted `ChangeValidators` event
            let mut events_iter = System::events().into_iter();
            let change_validators_event = events_iter.next().unwrap();
            assert_eq!(
                mock::Event::pallet_cash(crate::Event::ChangeValidators(val_keys.clone())),
                change_validators_event.event
            );
            // Check emitted `Notice` event
            let notice_event = events_iter.next().unwrap();
            let expected_notice_encoded = expected_notice.encode_notice();
            assert_eq!(
                mock::Event::pallet_cash(crate::Event::Notice(
                    expected_notice_id,
                    expected_notice.clone(),
                    expected_notice_encoded
                )),
                notice_event.event
            );
        });
    }

    #[test]
    fn test_change_validators_with_unset_keys() {
        new_test_ext().execute_with(|| {
            let substrate_id: AccountId32 = [2; 32].into();
            let vals = vec![ValidatorKeys {
                substrate_id: substrate_id.clone(),
                eth_address: [1; 20],
            }];
            assert_eq!(
                change_validators::<Test>(vals.clone()),
                Err(Reason::ChangeValidatorsError)
            );
        });
    }
}
